import sys
sys.path.insert(0,'/usr/local/lib/raspberry-host-heartbeat')
from heartbeat import main
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('{"heartbeat":"failed","details_withheld":true,"automatic_retry":false}',flush=True)
        raise SystemExit(1)
