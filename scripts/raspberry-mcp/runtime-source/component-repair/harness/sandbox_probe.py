"""Closed negative probes; candidate runs only after all boundaries pass."""
import ctypes,errno,json,os,socket,sys
DENIED={errno.EPERM,errno.EACCES}
PRIVATE=['/mnt/data/docker','/home','/root','/var/lib/raspberry-component-repair','/run/credentials']
def directory_inaccessible(path):
 if os.access(path,os.R_OK)or os.access(path,os.X_OK):return False
 try:fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 except OSError as error:return error.errno in DENIED|{errno.ENOENT}
 else:os.close(fd);return False
if __name__=='__main__':
 checks={'uid':os.getuid()==65534 and os.geteuid()==65534 and os.getgroups()in([], [65534])}
 if not checks['uid']:print(json.dumps({'sandbox_probe':'failed','checks':checks}),flush=True);raise SystemExit(1)
 libc=ctypes.CDLL(None,use_errno=True);checks['no_new_privileges']=libc.prctl(39,0,0,0,0)==1
 try:peer=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
 except OSError as error:inet_errno=error.errno;checks['inet_denied']=inet_errno in DENIED|{errno.EAFNOSUPPORT}
 else:peer.close();inet_errno=None;checks['inet_denied']=False
 checks['private_filesystem_denied']=all(directory_inaccessible(path)for path in PRIVATE)
 try:os.listdir('/proc')
 except OSError as error:proc_errno=error.errno;checks['proc_hidden']=proc_errno in DENIED|{errno.ENOENT}
 else:proc_errno=None;checks['proc_hidden']=False
 try:fd=os.open('/trusted/validate_profile.mjs',os.O_WRONLY)
 except OSError as error:write_errno=error.errno;checks['trusted_readonly']=write_errno in DENIED|{errno.EROFS}
 else:os.close(fd);write_errno=None;checks['trusted_readonly']=False
 passed=all(checks.values())
 print(json.dumps({'sandbox_probe':'passed'if passed else'failed','uid':os.getuid(),'no_new_privileges':checks['no_new_privileges'],'inet_denied':checks['inet_denied'],'proc_hidden':checks['proc_hidden'],'trusted_readonly':checks['trusted_readonly'],'private_filesystem_denied':checks['private_filesystem_denied'],'checks':checks,'errno':{'inet':inet_errno,'proc':proc_errno,'trusted_write':write_errno}}),flush=True)
 if not passed:raise SystemExit(1)
 os.execv('/bin/sh',['/bin/sh','/trusted/resource-safe.sh','/usr/bin/node','--jitless','--max-old-space-size=256','/trusted/validate_profile.mjs'])
