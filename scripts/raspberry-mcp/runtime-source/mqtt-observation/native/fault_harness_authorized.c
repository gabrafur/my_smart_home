/* Deterministic fault injection around the exact, unmodified sender source.
 * Syscall replacements cannot contact any broker, filesystem path or socket.
 * Only serialized metadata leaves this process.
 */
#define clock_gettime probe_clock_gettime
#define getrandom probe_getrandom
#define socket probe_socket
#define sendto probe_sendto
#define lstat probe_lstat
#define close probe_close
#include "native_sender_authorized.c"
#undef clock_gettime
#undef getrandom
#undef socket
#undef sendto
#undef lstat
#undef close
#include <assert.h>
#include <pthread.h>

static uint64_t fake_now=UINT64_C(1000000000);
static int authorization_mode;
static int clock_bad,random_bad,socket_bad,revoke_mode,send_error,short_send;
static int reg_fail_at,unregister_fail,register_calls,unregister_calls,close_calls,send_calls;
static int final_send_calls;
static pthread_barrier_t callback_arrived,callback_release;
static _Atomic bool pause_next_clock;
static unsigned nonce;
static const char *test_name="unset";
static void *owner;
static MOSQ_FUNC_generic_callback registered_callback;

int probe_clock_gettime(clockid_t id,struct timespec *out){
    assert(id==CLOCK_BOOTTIME);
    if(atomic_exchange(&pause_next_clock,false)){
        int rc=pthread_barrier_wait(&callback_arrived);assert(rc==0||rc==PTHREAD_BARRIER_SERIAL_THREAD);
        rc=pthread_barrier_wait(&callback_release);assert(rc==0||rc==PTHREAD_BARRIER_SERIAL_THREAD);
    }
    if(clock_bad){errno=EIO;return -1;}
    out->tv_sec=(time_t)(fake_now/UINT64_C(1000000000));
    out->tv_nsec=(long)(fake_now%UINT64_C(1000000000));return 0;
}
ssize_t probe_getrandom(void *buffer,size_t bytes,unsigned flags){
    assert(bytes==16 && flags==GRND_NONBLOCK);
    if(random_bad){errno=EAGAIN;return -1;}
    memset(buffer,(int)++nonce,bytes);return (ssize_t)bytes;
}
int probe_socket(int domain,int type,int protocol){
    assert(domain==AF_UNIX && type==(SOCK_DGRAM|SOCK_NONBLOCK|SOCK_CLOEXEC) && protocol==0);
    if(socket_bad){errno=EMFILE;return -1;}return 77;
}
int probe_lstat(const char *path,struct stat *out){
    if(strcmp(path,AUTHORIZED_FILE)==0){
        if(authorization_mode==1){errno=ENOENT;return -1;}
        if(authorization_mode==2){errno=EACCES;return -1;}
        memset(out,0,sizeof(*out));out->st_mode=S_IFREG|0444;out->st_nlink=1;
        if(authorization_mode==3)out->st_uid=1000;
        if(authorization_mode==4)out->st_gid=1883;
        if(authorization_mode==5)out->st_mode=S_IFREG|0666;
        if(authorization_mode==6)out->st_mode=S_IFLNK|0444;
        if(authorization_mode==7)out->st_nlink=2;
        if(authorization_mode==8)out->st_size=1;
        return 0;
    }
    assert(strcmp(path,REVOKED_FILE)==0);(void)out;
    if(revoke_mode==1)return 0;
    errno=revoke_mode==2?EACCES:ENOENT;return -1;
}
int probe_close(int fd){assert(fd==77);close_calls++;return 0;}
ssize_t probe_sendto(int fd,const void *buffer,size_t bytes,int flags,const struct sockaddr *address,socklen_t size){
    assert(fd==77 && flags==(MSG_DONTWAIT|MSG_NOSIGNAL));
    assert(size==sizeof(struct sockaddr_un) && address->sa_family==AF_UNIX);
    assert(strcmp(((const struct sockaddr_un*)address)->sun_path,SOURCE_SOCKET)==0);
    assert(bytes<FRAME_LIMIT);send_calls++;
    if(strstr(buffer,"\"final\":true"))final_send_calls++;
    if(send_error){errno=send_error;return -1;}
    if(short_send)return (ssize_t)bytes-1;
    printf("{\"type\":\"frame\",\"case\":\"%s\",\"arrived_ns\":\"%"PRIu64"\",\"wire\":",test_name,fake_now+1000);
    fwrite(buffer,1,bytes,stdout);puts("}");
    return (ssize_t)bytes;
}
int mosquitto_callback_register(mosquitto_plugin_id_t *identifier,int event,MOSQ_FUNC_generic_callback cb,const void *data,void *userdata){
    assert(identifier==(mosquitto_plugin_id_t*)(uintptr_t)1 && data==NULL && userdata==&s);
    assert(register_calls<CLASSES+1 && event==hooks[register_calls] && cb==metadata_callback);
    register_calls++;registered_callback=cb;
    return register_calls==reg_fail_at?MOSQ_ERR_NOT_SUPPORTED:MOSQ_ERR_SUCCESS;
}
int mosquitto_callback_unregister(mosquitto_plugin_id_t *identifier,int event,MOSQ_FUNC_generic_callback cb,const void *data){
    assert(identifier==(mosquitto_plugin_id_t*)(uintptr_t)1 && cb==metadata_callback && data==NULL);
    bool allowed=false;for(unsigned i=0;i<CLASSES+1;i++)if(event==hooks[i])allowed=true;
    assert(allowed);unregister_calls++;return unregister_fail?MOSQ_ERR_NOT_SUPPORTED:MOSQ_ERR_SUCCESS;
}
static void begin(const char *name){
    /* Each previous lifecycle has already returned from cleanup. */
    test_name=name;authorization_mode=0;clock_bad=random_bad=socket_bad=revoke_mode=send_error=short_send=0;
    reg_fail_at=unregister_fail=register_calls=unregister_calls=close_calls=send_calls=final_send_calls=0;
    atomic_store(&pause_next_clock,false);
    fake_now=UINT64_C(1000000000);owner=NULL;registered_callback=NULL;
}
static void start(void){
    assert(mosquitto_plugin_init((mosquitto_plugin_id_t*)(uintptr_t)1,&owner,NULL,0)==MOSQ_ERR_SUCCESS);
}
static void event(int hook){
    assert(registered_callback!=NULL);
    /* Invalid native-object pointers catch any attempt to dereference payload/client data. */
    assert(registered_callback(hook,(void*)(uintptr_t)1,(void*)(uintptr_t)2)==MOSQ_ERR_SUCCESS);
    assert(atomic_load(&s.callbacks)==0);
}
static void tick(void){fake_now+=SEND_INTERVAL_NS;event(MOSQ_EVT_TICK);}
static void finish(void){
    assert(mosquitto_plugin_cleanup(owner,NULL,0)==MOSQ_ERR_SUCCESS);
    printf("{\"type\":\"case_passed\",\"case\":\"%s\",\"production_changes\":false}\n",test_name);
}
static void *concurrent_callback(void *unused){
    (void)unused;event(MOSQ_EVT_CONNECT);return NULL;
}
int main(void){
    begin("all_seven");
    start();for(unsigned k=0;k<CLASSES;k++)event(hooks[k]);tick();
    assert(s.event_seq==7 && s.used==0 && !disabled());
    for(unsigned k=0;k<CLASSES;k++)assert(s.total[k]==1 && s.dropped[k]==0);
    finish();assert(close_calls==1 && unregister_calls==8);

    begin("receiver_unavailable_recovery");
    send_error=ENOENT;start();
    for(unsigned i=0;i<10;i++)event(MOSQ_EVT_MESSAGE_IN);
    assert(s.used==10 && s.frame_seq==0 && s.send_failures==1);
    send_error=0;tick();
    assert(s.used==0 && s.frame_seq==1 && s.total[0]==10 && s.dropped[0]==0);
    finish();

    begin("backpressure_ring_overflow");
    send_error=EAGAIN;start();
    for(unsigned i=0;i<300;i++)event(MOSQ_EVT_MESSAGE_IN);
    assert(s.used==256 && s.total[0]==300 && s.dropped[0]==44 && !disabled());
    send_error=0;tick();assert(s.used==0 && s.frame_seq==1);
    finish();

    begin("kernel_accepted_frame_loss");
    start();event(MOSQ_EVT_MESSAGE_IN);tick();
    event(MOSQ_EVT_MESSAGE_IN);tick();assert(s.total[0]==2);
    finish();

    begin("single_try_contention");
    start();assert(!atomic_flag_test_and_set(&s.lock));
    for(unsigned i=0;i<3;i++)event(MOSQ_EVT_MESSAGE_IN);
    atomic_flag_clear(&s.lock);
    event(MOSQ_EVT_MESSAGE_IN);tick();
    assert(s.event_seq==4 && s.dropped[0]==3 && s.total[0]==4 && !disabled());
    finish();

    begin("clock_unknown_then_recovery");
    clock_bad=1;start();event(MOSQ_EVT_CONNECT);
    clock_bad=0;tick();
    assert(!s.started_known && s.clock_faults>=2 && s.total[2]==1 && !disabled());
    finish();

    begin("revoked_at_start");
    revoke_mode=1;start();assert(disabled() && register_calls==0 && send_calls==0);finish();

    begin("revocation_read_denied");
    revoke_mode=2;start();assert(disabled() && register_calls==0 && send_calls==0);finish();

    begin("revoked_during_run");
    start();int sent=send_calls;
    revoke_mode=1;tick();event(MOSQ_EVT_CONNECT);
    assert(disabled() && send_calls==sent && s.total[2]==0);finish();

    begin("registration_partial_failure");
    reg_fail_at=4;start();
    assert(disabled() && register_calls==4 && unregister_calls==3 && close_calls==1 && owner==NULL);
    finish();assert(close_calls==1);

    begin("nonce_unavailable");
    random_bad=1;start();assert(disabled() && register_calls==0);finish();

    begin("socket_unavailable");
    socket_bad=1;start();assert(disabled() && register_calls==0 && close_calls==0);finish();

    begin("unsupported_options");
    assert(mosquitto_plugin_init((mosquitto_plugin_id_t*)(uintptr_t)1,&owner,NULL,1)==MOSQ_ERR_SUCCESS);
    assert(disabled() && register_calls==0);finish();

    begin("event_counter_exhausted");
    start();s.event_seq=UINT64_MAX;event(MOSQ_EVT_CONNECT);
    assert(disabled() && s.event_seq==UINT64_MAX && s.total[2]==0);finish();

    begin("frame_counter_exhausted");
    start();s.frame_seq=UINT64_MAX;int before=send_calls;tick();
    assert(disabled() && send_calls==before);finish();

    begin("short_datagram_impossible");
    short_send=1;start();assert(disabled() && s.frame_seq==0);finish();

    begin("cleanup_contended");
    start();assert(!atomic_flag_test_and_set(&s.lock));
    assert(mosquitto_plugin_cleanup(owner,NULL,0)==MOSQ_ERR_SUCCESS);
    assert(disabled() && !atomic_load(&s.active) && close_calls==0 && unregister_calls==8);
    atomic_flag_clear(&s.lock); /* Process owns no real fd; OS exit is production fallback. */
    printf("{\"type\":\"case_passed\",\"case\":\"%s\",\"production_changes\":false}\n",test_name);

    const char *authorization_names[]={"unused","authorization_absent","authorization_denied","authorization_owner_invalid",
        "authorization_group_invalid","authorization_writable","authorization_symlink","authorization_hardlink","authorization_nonempty"};
    for(int mode=1;mode<=8;mode++){
        begin(authorization_names[mode]);authorization_mode=mode;start();
        assert(disabled() && register_calls==0 && send_calls==0);finish();
    }
    begin("authorization_removed_before_publish");
    start();int authorization_before=send_calls;authorization_mode=1;fake_now+=SEND_INTERVAL_NS;event(MOSQ_EVT_MESSAGE_IN);
    assert(disabled() && send_calls==authorization_before);finish();
    begin("authorization_removed_before_cleanup");
    start();authorization_before=send_calls;authorization_mode=1;finish();assert(disabled() && send_calls==authorization_before);
    begin("revoked_before_publish_without_tick");
    start();authorization_before=send_calls;revoke_mode=1;fake_now+=SEND_INTERVAL_NS;event(MOSQ_EVT_MESSAGE_IN);
    assert(disabled() && send_calls==authorization_before);finish();
    begin("authorization_return_does_not_reactivate");
    start();authorization_before=send_calls;authorization_mode=1;tick();authorization_mode=0;tick();event(MOSQ_EVT_CONNECT);
    assert(disabled() && send_calls==authorization_before && s.total[2]==0);finish();

    begin("terminal_clean");
    start();assert(!s.final);finish();assert(s.final && final_send_calls==1 && s.frame_seq==2);

    begin("cleanup_unregistration_failure");
    start();unregister_fail=1;finish();assert(disabled() && !s.final && final_send_calls==0);

    begin("cleanup_callback_active");
    start();
    assert(pthread_barrier_init(&callback_arrived,NULL,2)==0);
    assert(pthread_barrier_init(&callback_release,NULL,2)==0);
    atomic_store(&pause_next_clock,true);pthread_t thread;
    assert(pthread_create(&thread,NULL,concurrent_callback,NULL)==0);
    int rc=pthread_barrier_wait(&callback_arrived);assert(rc==0||rc==PTHREAD_BARRIER_SERIAL_THREAD);
    assert(atomic_load(&s.callbacks)==1);finish();assert(disabled() && !s.final && final_send_calls==0);
    rc=pthread_barrier_wait(&callback_release);assert(rc==0||rc==PTHREAD_BARRIER_SERIAL_THREAD);
    assert(pthread_join(thread,NULL)==0);assert(atomic_load(&s.callbacks)==0);
    assert(pthread_barrier_destroy(&callback_arrived)==0 && pthread_barrier_destroy(&callback_release)==0);

    begin("cleanup_final_send_failed");
    start();send_error=EAGAIN;finish();assert(s.final && s.frame_seq==1 && s.send_failures==1);

    begin("cleanup_final_clock_failed");
    start();clock_bad=1;finish();assert(s.final && final_send_calls==0 && s.frame_seq==1);

    begin("callback_after_cleanup");
    start();finish();int closed_send_calls=send_calls;
    event(MOSQ_EVT_CONNECT);assert(s.total[2]==0 && send_calls==closed_send_calls && atomic_load(&s.callbacks)==0);

    assert(mosquitto_plugin_version(1,(int[]){5})==5);
    assert(mosquitto_plugin_version(1,(int[]){4})==-1);
    assert(mosquitto_plugin_version(1,NULL)==-1);
    puts("{\"type\":\"suite_passed\",\"cases\":35,\"real_syscalls_injected\":true,\"household_effects\":false}");
    return 0;
}
