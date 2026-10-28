/* Unarmed candidate. Native metadata only; never dereferences event_data.
 * The default project GPL-3.0 license applies to this original implementation.
 * Build against the separately pinned official Mosquitto SDK.
 */
#define _GNU_SOURCE
#include <mosquitto/broker.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define CLASSES 7
#define CAPACITY 256
#define FRAME_LIMIT 32768
#define SEND_INTERVAL_NS UINT64_C(250000000)
#define SOURCE_SOCKET "/run/raspberry-mqtt-observation/source.sock"
#define AUTHORIZED_FILE "/run/raspberry-mqtt-observation/authorized"
#define REVOKED_FILE "/run/raspberry-mqtt-observation/revoked"

static const char *names[CLASSES]={"publish_in","publish_out","connect","disconnect","subscribe","unsubscribe","client_offline"};
static const int hooks[CLASSES+1]={MOSQ_EVT_MESSAGE_IN,MOSQ_EVT_MESSAGE_OUT,MOSQ_EVT_CONNECT,MOSQ_EVT_DISCONNECT,MOSQ_EVT_SUBSCRIBE,MOSQ_EVT_UNSUBSCRIBE,MOSQ_EVT_CLIENT_OFFLINE,MOSQ_EVT_TICK};
struct item {uint64_t seq,at;unsigned kind;bool known;};
static struct {
    atomic_flag lock;
    _Atomic bool disabled,active;
    _Atomic unsigned callbacks;
    _Atomic uint64_t pending_drop[CLASSES],pending_faults;
    bool started_known,final,close_known;
    uint64_t close_before;
    int fd,registered;
    mosquitto_plugin_id_t *identifier;
    uint64_t started,event_seq,frame_seq,total[CLASSES],dropped[CLASSES];
    uint64_t clock_faults,send_failures,last_attempt;
    char instance[33],buffer[FRAME_LIMIT];
    struct item pending[CAPACITY];
    unsigned used;
} s;

static void disable(void){atomic_store_explicit(&s.disabled,true,memory_order_release);}
static bool disabled(void){return atomic_load_explicit(&s.disabled,memory_order_acquire);}
static bool add(uint64_t *value,uint64_t amount){
    if(UINT64_MAX-*value<amount){disable();return false;}
    *value+=amount;return true;
}
static bool clock_ns(uint64_t *out){
    struct timespec t;
    if(clock_gettime(CLOCK_BOOTTIME,&t)!=0||t.tv_sec<0||t.tv_nsec<0||t.tv_nsec>=1000000000L)return false;
    if((uint64_t)t.tv_sec>(UINT64_MAX-(uint64_t)t.tv_nsec)/UINT64_C(1000000000))return false;
    *out=(uint64_t)t.tv_sec*UINT64_C(1000000000)+(uint64_t)t.tv_nsec;return true;
}
static void atomic_increment(_Atomic uint64_t *value){
    if(atomic_fetch_add_explicit(value,1,memory_order_relaxed)==UINT64_MAX)disable();
}
static bool revoke_present(void){
    struct stat info;
    if(lstat(REVOKED_FILE,&info)==0)return true;
    return errno!=ENOENT;
}
/* Root creates this empty marker only after validating the durable owner policy.
 * Missing, inaccessible, writable or replaced-with-link authorization fails closed.
 * This is metadata-only telemetry; broker callbacks always keep their normal result.
 */
static bool authorized(void){
    struct stat info;
    return lstat(AUTHORIZED_FILE,&info)==0 && S_ISREG(info.st_mode)
        && info.st_uid==0 && info.st_gid==0 && (info.st_mode&07777)==0444
        && info.st_nlink==1 && info.st_size==0;
}
static bool append(size_t *used,const char *format,...){
    va_list args;va_start(args,format);
    int n=vsnprintf(s.buffer+*used,FRAME_LIMIT-*used,format,args);va_end(args);
    if(n<0||(size_t)n>=FRAME_LIMIT-*used){disable();return false;}
    *used+=(size_t)n;return true;
}
static bool stamp(size_t *used,uint64_t value,bool known){
    return known?append(used,"\"%"PRIu64"\"",value):append(used,"null");
}
static bool counters(size_t *used,const uint64_t *values){
    if(!append(used,"{"))return false;
    for(unsigned k=0;k<CLASSES;k++)if(!append(used,"%s\"%s\":\"%"PRIu64"\"",k?",":"",names[k],values[k]))return false;
    return append(used,"}");
}
static bool drain_drops(void){
    for(unsigned k=0;k<CLASSES;k++){
        uint64_t n=atomic_exchange_explicit(&s.pending_drop[k],0,memory_order_relaxed);
        if(!add(&s.event_seq,n)||!add(&s.total[k],n)||!add(&s.dropped[k],n))return false;
    }
    return add(&s.clock_faults,atomic_exchange_explicit(&s.pending_faults,0,memory_order_relaxed));
}
/* Caller holds the single-try lock. Never waits for a peer or socket space. */
static void emit_frame(bool force,unsigned caller_callbacks){
    if(disabled()||s.fd<0)return;
    uint64_t now;
    if(!clock_ns(&now)){(void)add(&s.clock_faults,1);return;}
    if(!force&&s.last_attempt&&now>=s.last_attempt&&now-s.last_attempt<SEND_INTERVAL_NS)return;
    if(now<s.last_attempt){disable();return;}
    if(revoke_present()||!authorized()){disable();return;}
    /* A send timestamp alone is not a callback frontier. Drain pending drops
     * after sampling the clock, then acquire the callback count before reading
     * pending atomics. An older paused callback prevents a new frontier; one
     * entering after this check has a timestamp >= now. No wait or spin. */
    if(!drain_drops())return;
    bool covered=atomic_load_explicit(&s.callbacks,memory_order_seq_cst)==caller_callbacks;
    for(unsigned k=0;k<CLASSES;k++)if(atomic_load_explicit(&s.pending_drop[k],memory_order_acquire))covered=false;
    if(atomic_load_explicit(&s.pending_faults,memory_order_acquire))covered=false;
    uint64_t before=now;
    if(s.final){covered=covered&&s.close_known&&s.close_before<=now;before=s.close_before;}
    s.last_attempt=now;
    if(s.frame_seq==UINT64_MAX){disable();return;}
    size_t used=0;
    if(!append(&used,"{\"v\":3,\"final\":%s,\"covered_before_ns\":",s.final?"true":"false")
       ||!stamp(&used,before,covered)
       ||!append(&used,",\"instance\":\"%s\",\"started_ns\":",s.instance)
       ||!stamp(&used,s.started,s.started_known)
       ||!append(&used,",\"frame_seq\":\"%"PRIu64"\",\"event_seq\":\"%"PRIu64"\",\"totals\":",s.frame_seq+1,s.event_seq)
       ||!counters(&used,s.total)||!append(&used,",\"source_dropped\":")||!counters(&used,s.dropped)
       ||!append(&used,",\"clock_faults\":\"%"PRIu64"\",\"send_failures\":\"%"PRIu64"\",\"emitted_ns\":\"%"PRIu64"\",\"events\":[",s.clock_faults,s.send_failures,now))return;
    for(unsigned i=0;i<s.used;i++){
        const struct item *row=&s.pending[i];
        if(!append(&used,"%s{\"seq\":\"%"PRIu64"\",\"kind\":\"%s\",\"at_ns\":",i?",":"",row->seq,names[row->kind])
           ||!stamp(&used,row->at,row->known)||!append(&used,"}"))return;
    }
    if(!append(&used,"]}")||disabled())return;
    struct sockaddr_un address={.sun_family=AF_UNIX};
    memcpy(address.sun_path,SOURCE_SOCKET,sizeof(SOURCE_SOCKET));
    ssize_t sent=sendto(s.fd,s.buffer,used,MSG_DONTWAIT|MSG_NOSIGNAL,(const struct sockaddr*)&address,sizeof(address));
    if(sent==(ssize_t)used){s.frame_seq++;s.used=0;}
    else if(sent<0){(void)add(&s.send_failures,1);}
    else{disable();}
}
static void emit(bool force){emit_frame(force,0);}
static int metadata_callback(int event,void *event_data,void *userdata){
    /* No client, topic, payload, properties, password or native object access. */
    (void)event_data;(void)userdata;
    /* Count entry BEFORE checking the gate. The sequentially consistent gate
     * and counter order make cleanup distinguish a pre-close callback from a
     * later entry that must not collect. This counts concurrent threads only,
     * not lifetime events; Linux task limits fit in unsigned. Never wait. */
    atomic_fetch_add_explicit(&s.callbacks,1,memory_order_seq_cst);
    if(disabled()||!atomic_load_explicit(&s.active,memory_order_seq_cst))goto leave;
    int kind=-1;
    for(unsigned k=0;k<CLASSES;k++)if(event==hooks[k]){kind=(int)k;break;}
    if(kind<0&&event!=MOSQ_EVT_TICK)goto leave;
    if(event==MOSQ_EVT_TICK&&(revoke_present()||!authorized())){disable();goto leave;}
    uint64_t occurred=0;bool known=clock_ns(&occurred);
    if(atomic_flag_test_and_set_explicit(&s.lock,memory_order_acquire)){
        if(kind>=0)atomic_increment(&s.pending_drop[kind]);
        if(!known)atomic_increment(&s.pending_faults);
        goto leave;
    }
    if(!drain_drops())goto done;
    if(!known&&!add(&s.clock_faults,1))goto done;
    if(kind>=0){
        if(!add(&s.event_seq,1)||!add(&s.total[kind],1))goto done;
        if(s.used<CAPACITY){s.pending[s.used++]=(struct item){.seq=s.event_seq,.at=occurred,.kind=(unsigned)kind,.known=known};}
        else if(!add(&s.dropped[kind],1))goto done;
    }
    emit_frame(false,1);
done:
    atomic_flag_clear_explicit(&s.lock,memory_order_release);
leave:
    atomic_fetch_sub_explicit(&s.callbacks,1,memory_order_seq_cst);
    return MOSQ_ERR_SUCCESS;
}

struct mosquitto_opt;
int mosquitto_plugin_version(int count,const int *supported){
    if(count<0||count>64||(!supported&&count))return -1;
    for(int i=0;i<count;i++)if(supported[i]==5)return 5;
    return -1;
}
int mosquitto_plugin_init(mosquitto_plugin_id_t *identifier,void **userdata,struct mosquitto_opt *options,int count){
    (void)options;
    if(!userdata)return MOSQ_ERR_SUCCESS;
    *userdata=NULL;
    if(atomic_load_explicit(&s.active,memory_order_acquire))return MOSQ_ERR_SUCCESS;
    memset(&s,0,sizeof(s));s.fd=-1;atomic_flag_clear(&s.lock);
    atomic_init(&s.disabled,false);atomic_init(&s.active,false);atomic_init(&s.pending_faults,0);
    atomic_init(&s.callbacks,0);
    for(unsigned k=0;k<CLASSES;k++)atomic_init(&s.pending_drop[k],0);
    /* Unsupported configuration disables telemetry, preserving broker service. */
    if(!identifier||count!=0||revoke_present()||!authorized()||!atomic_is_lock_free(&s.pending_faults)
       ||!atomic_is_lock_free(&s.callbacks)){disable();return MOSQ_ERR_SUCCESS;}
    unsigned char random[16];
    if(getrandom(random,sizeof(random),GRND_NONBLOCK)!=(ssize_t)sizeof(random)){disable();return MOSQ_ERR_SUCCESS;}
    for(unsigned i=0;i<sizeof(random);i++)(void)snprintf(s.instance+2*i,3,"%02x",random[i]);
    s.fd=socket(AF_UNIX,SOCK_DGRAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);
    if(s.fd<0){disable();return MOSQ_ERR_SUCCESS;}
    s.identifier=identifier;*userdata=&s;
    for(unsigned i=0;i<CLASSES+1;i++){
        if(mosquitto_callback_register(identifier,hooks[i],metadata_callback,NULL,&s)!=MOSQ_ERR_SUCCESS){
            disable();
            for(int j=s.registered-1;j>=0;j--)(void)mosquitto_callback_unregister(identifier,hooks[j],metadata_callback,NULL);
            close(s.fd);s.fd=-1;atomic_store(&s.active,false);*userdata=NULL;return MOSQ_ERR_SUCCESS;
        }
        s.registered++;
    }
    s.started_known=clock_ns(&s.started);if(!s.started_known)s.clock_faults=1;
    atomic_store_explicit(&s.active,true,memory_order_seq_cst);
    if(!atomic_flag_test_and_set_explicit(&s.lock,memory_order_acquire)){
        (void)drain_drops();emit(true);
        atomic_flag_clear_explicit(&s.lock,memory_order_release);
    }
    return MOSQ_ERR_SUCCESS;
}
int mosquitto_plugin_cleanup(void *userdata,struct mosquitto_opt *options,int count){
    (void)options;(void)count;
    if(userdata!=&s)return MOSQ_ERR_SUCCESS;
    uint64_t before_close=0;bool close_known=clock_ns(&before_close);
    atomic_store_explicit(&s.active,false,memory_order_seq_cst);
    bool unregistered=true;
    for(int i=s.registered-1;i>=0;i--)
        if(mosquitto_callback_unregister(s.identifier,hooks[i],metadata_callback,NULL)!=MOSQ_ERR_SUCCESS)unregistered=false;
    if(!atomic_flag_test_and_set_explicit(&s.lock,memory_order_acquire)){
        if(unregistered&&atomic_load_explicit(&s.callbacks,memory_order_seq_cst)==0){
            s.final=true;s.close_known=close_known;s.close_before=before_close;
            if(!close_known)(void)add(&s.clock_faults,1);
            if(drain_drops())emit(true);
        }
        disable();
        if(s.fd>=0)close(s.fd);
        s.fd=-1;
        atomic_flag_clear_explicit(&s.lock,memory_order_release);
    }else{
        /* Never close/reuse an in-flight descriptor. The reviewed profile
         * loads at process start and unloads at shutdown, not live dlclose. */
        disable();
    }
    return MOSQ_ERR_SUCCESS;
}
