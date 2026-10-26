"""Closed installer policy construction; not a caller-controlled privilege API."""
import copy,hashlib,json
EXPIRY=0
RELEASE='13ddafc15d35d08fead8cfcb7f088b2718d3b14a4bbf7c109a33555eb7716f22'
TARGETS={
 'service_probe.cjs':'/usr/local/lib/raspberry-ha-notices/service_probe.cjs',
 'icloud-readiness.json':'/usr/local/lib/raspberry-ha-notices/icloud-readiness.json',
 'notification_collector.cjs':'/usr/local/lib/raspberry-ha-notices/notification_collector.cjs',
 'icloud_readiness.py':'/usr/local/lib/raspberry-admin-executor/icloud_readiness.py',
 'executor.py':'/usr/local/lib/raspberry-admin-executor/executor.py',
 'recovery.py':'/usr/local/lib/raspberry-admin-recovery/recovery.py',
 'icloud-readiness.conf':'/etc/systemd/system/raspberry-admin-executor@.service.d/zzzz-icloud-readiness.conf',
 'readiness_client.py':'/usr/local/lib/raspberry-repair-control/readiness_client.py',
 'repair-broker.py':'/usr/local/lib/raspberry-repair-control/repair-broker.py',
 'admin-policy.json':'/usr/local/lib/raspberry-admin-executor/policy.json',
 'repair-policy.json':'/usr/local/lib/raspberry-repair-control/policy.json',
}
UNCHANGED=(
 '/etc/systemd/system/raspberry-admin-executor@.service',
 '/etc/systemd/system/raspberry-admin-executor@.service.d/zz-setuid-recovery.conf',
 '/etc/systemd/system/raspberry-admin-executor.socket',
 '/etc/systemd/system/raspberry-ha-notices.service',
 '/usr/local/lib/raspberry-task-control/policy.json',
)
UNIT_CONF='''[Service]
# Fixed proof/marker and local Docker metadata only, consumed by sealed root code.
# A read-only socket mount does not make the Docker API itself read-only.
BindReadOnlyPaths=-/mnt/data/docker/homeassistant/.mcp-icloud-proof.json:/run/raspberry-icloud-read/proof.json
BindReadOnlyPaths=-/mnt/data/docker/homeassistant/.mcp-icloud-activation.json:/run/raspberry-icloud-read/activation.json
BindReadOnlyPaths=-/run/docker.sock:/run/raspberry-icloud-read/docker.sock
'''
def need(v,r):
 if not v:raise ValueError(r)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def raw(value):return(json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
def proposed(before,payload,unchanged):
 need(set(before)==set(payload)==set(TARGETS)and set(unchanged)==set(UNCHANGED),'package_scope_changed')
 scope={'schema_version':1,'enabled':True,'expires_at':EXPIRY,'minimum_poll_seconds':60}
 value=json.loads(payload['icloud-readiness.json']);need(value==scope and type(value.get('schema_version'))is int and value.get('enabled')is True and type(value.get('minimum_poll_seconds'))is int and payload['icloud-readiness.conf']==UNIT_CONF.encode(),'readonly_scope_or_unit_mounts_changed')
 admin=json.loads(before['admin-policy.json']);repair=json.loads(before['repair-policy.json'])
 need(admin['enabled']is True and repair['enabled']is True and admin['expires_at']==repair['expires_at']==EXPIRY and repair['maximum_submissions']==2,'authority_or_limits_changed')
 need('readiness_scope'not in admin and 'icloud_readiness.py'not in admin['sealed'],'existing_readiness_scope_requires_reconciliation')
 admin['readiness_scope']={'enabled':True,'expires_at':EXPIRY,'expected_release_revision':RELEASE,'minimum_poll_seconds':60}
 admin['sealed']['executor.py']=sha(payload['executor.py']);admin['sealed']['icloud_readiness.py']=sha(payload['icloud_readiness.py'])
 for name in ['notification_collector.cjs','service_probe.cjs','icloud-readiness.json','recovery.py','icloud-readiness.conf']:
  admin['dependencies'][TARGETS[name]]=sha(payload[name])
 for path in UNCHANGED[:4]:admin['dependencies'][path]=sha(unchanged[path])
 admin_raw=raw(admin);repair['source_hashes']['repair-broker.py']=sha(payload['repair-broker.py'])
 repair['dependencies'][TARGETS['admin-policy.json']]=sha(admin_raw);repair['dependencies'][TARGETS['readiness_client.py']]=sha(payload['readiness_client.py'])
 return {**payload,'admin-policy.json':admin_raw,'repair-policy.json':raw(repair)}
