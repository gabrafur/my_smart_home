"""One fixed external heartbeat. No logs, household payload, AI or retries."""
import datetime
import json
import os
import re
import resource
import stat
import socket
import ssl
import http.client
import time
import sys

from webhook import post
from history import History
from loaded_identity import capture as capture_loaded_identity

HISTORY='.'
CREDENTIAL='/run/credentials/raspberry-host-heartbeat.service/heartbeat_uuid'


def send_once(identifier, sender=post, clock=time.time):
    if not isinstance(identifier,str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',identifier):
        raise ValueError('invalid_check_identifier')
    started=clock();monotonic_started=time.monotonic()
    result={'source':'fixed_external_host_heartbeat','observed_at':datetime.datetime.fromtimestamp(started,datetime.timezone.utc).isoformat(),
            'automatic_retry':False,'coverage':['provider_acceptance_only','not_phone_delivery','not_household_health'],
            'body_bytes':0,'provider':'healthchecks.io'}
    try:
        status,body=sender('https://hc-ping.com/'+identifier,{'Content-Length':'0'},b'')
        accepted=status==200 and body.strip()==b'OK'
        result.update({'state':'provider_accepted' if accepted else 'provider_refused',
                       'http_status':status if type(status) is int and 100<=status<=599 else None,
                       'failure_category':None if accepted else 'unexpected_provider_response' if status==200 else 'http_refused'})
    except Exception as error:
        # Enumerated exception category only; never persist host, path, UUID,
        # remote response body, exception message or credentials.
        category=('dns_resolution_error' if isinstance(error,socket.gaierror) else
                  'tls_certificate_error' if isinstance(error,ssl.SSLCertVerificationError) else
                  'tls_error' if isinstance(error,ssl.SSLError) else
                  'timeout_exception' if isinstance(error,TimeoutError) else
                  'connection_error' if isinstance(error,ConnectionError) else
                  'http_protocol_error' if isinstance(error,http.client.HTTPException) else
                  'os_error' if isinstance(error,OSError) else 'transport_exception_unclassified')
        result.update({'state':'uncertain','http_status':None,'failure_category':category})
    result['duration_ms']=round(max(0,time.monotonic()-monotonic_started)*1000,3)
    return result


def main():
    if os.geteuid()==0:raise ValueError('non_root_required')
    resource.setrlimit(resource.RLIMIT_AS,(128*1048576,128*1048576))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    fd=os.open(CREDENTIAL,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_size>64
                or stat.S_IMODE(info.st_mode) not in (0o400,0o440)
                or not os.fstatvfs(stream.fileno()).f_flag & os.ST_RDONLY):
            raise ValueError('unsafe_credential')
        identifier=stream.read(65).decode('ascii').strip()
    history=History(HISTORY)
    try:
        observation=history.begin()  # Durable intent before network, no replay.
        result=send_once(identifier)
        try:loaded=capture_loaded_identity(sys.modules[__name__])
        except Exception:loaded=None  # Observation failure must not add/retry a request.
        history.finish(observation,result,loaded)
        history.publish_status()
        result['observation_id']=observation
        result['collection_error']=None if result['state']=='provider_accepted' else result['state']
        print(json.dumps(result),flush=True)
        return 0 if result['state']=='provider_accepted' else 1
    finally:history.close()


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('{"heartbeat":"failed","details_withheld":true,"automatic_retry":false}',flush=True)
        raise SystemExit(1)
