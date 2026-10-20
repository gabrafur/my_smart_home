"""Versioned read-only diagnostics. No caller paths, commands, URLs or imports."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

FIELDS = {
    'maintenance_capabilities': (),
    'host_diagnostics': (),
    'service_diagnostics': ('service',),
    'operation_status': ('change_id',),
    'change_validate': ('change_id',),
}
SERVICES = ('homeassistant', 'nodered', 'mosquitto')
ENV = {'PATH': '/usr/bin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock'}

def utc(epoch=None):
    return dt.datetime.fromtimestamp(time.time() if epoch is None else epoch, dt.timezone.utc).isoformat()

def evidence(source, data, state='unknown', error=None, observed=None, coverage=None, now=None, ttl=120):
    now = time.time() if now is None else now
    observed = now if observed is None else observed
    age = max(0, now-observed)
    return {'source': source, 'observed_at': utc(observed), 'age_seconds': round(age, 3),
            'collection_error': error, 'coverage': coverage or [],
            'state': 'stale' if age > ttl else state, 'data': data}

def read_fixed(path, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('unsupported_source')
        data = os.read(fd, limit+1)
        if len(data) > limit:
            raise ValueError('source_too_large')
        return data.decode('utf8')
    finally:
        os.close(fd)

def command(argv, input_data=None):
    # Only fixed, small-output commands below may call this helper. Stderr can
    # contain source/private runtime data and must never leave this process.
    result = subprocess.run(argv, input=input_data, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=ENV, timeout=5)
    if result.returncode:
        raise ValueError('collector_failed')
    if len(result.stdout) > 65536:
        raise ValueError('source_too_large')
    return result.stdout.decode('utf8')

def collect(source, fn, coverage):
    try:
        return evidence(source, fn(), coverage=coverage)
    except (OSError, ValueError, subprocess.SubprocessError, UnicodeError, KeyError):
        return evidence(source, None, error='unavailable_or_invalid', coverage=coverage)

def memory(read=read_fixed):
    values = {}
    for line in read('/proc/meminfo').splitlines():
        match = re.fullmatch(r'(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB', line)
        if match:
            values[match[1]] = int(match[2])*1024
    if len(values) != 4 or values['MemTotal'] <= 0:
        raise ValueError('invalid_memory')
    return values

def cpu(read=read_fixed, sleep=time.sleep):
    def sample():
        row = read('/proc/stat').splitlines()[0].split()
        if row[0] != 'cpu' or len(row) < 9:
            raise ValueError('invalid_cpu')
        # guest and guest_nice are already included in user/nice.
        counters = [int(x) for x in row[1:9]]
        return sum(counters), counters[3]+counters[4]
    total1, idle1 = sample()
    sleep(0.1)
    total2, idle2 = sample()
    total, idle = total2-total1, idle2-idle1
    if total <= 0 or not 0 <= idle <= total:
        raise ValueError('invalid_cpu_delta')
    return {'busy_percent': round(100*(total-idle)/total, 2), 'sample_seconds': 0.1}

def filesystem():
    row = os.statvfs('/mnt/data/docker')
    return {'total_bytes': row.f_blocks*row.f_frsize, 'available_bytes': row.f_bavail*row.f_frsize,
            'total_inodes': row.f_files, 'free_inodes': row.f_favail}

def throttling():
    raw = command(['/usr/bin/vcgencmd', 'get_throttled']).strip()
    if not re.fullmatch(r'throttled=0x[0-9a-fA-F]{1,8}', raw):
        raise ValueError('invalid_throttling')
    value = int(raw.split('=')[1], 16)
    return {'current_flags': value & 15, 'historical_flags': (value >> 16) & 15,
            'history_window': 'since_boot', 'raw_mask': value}

def host_diagnostics():
    def temperature():
        value = int(read_fixed('/sys/class/thermal/thermal_zone0/temp', 64))/1000
        if not -40 <= value <= 150:
            raise ValueError('invalid_temperature')
        return {'celsius': value}
    return {'cpu': collect('proc.stat', cpu, ['short_cpu_sample_not_trend']),
            'memory': collect('proc.meminfo', memory, ['memory_swap_bytes']),
            'filesystem': collect('statvfs.project_filesystem', filesystem, ['space_inodes_single_filesystem']),
            'temperature': collect('sysfs.thermal_zone0', temperature, ['single_thermal_zone']),
            'throttling': collect('vcgencmd.get_throttled', throttling, ['may_be_unavailable_in_sandbox']),
            'trends': evidence('not_collected', None, coverage=['no_historical_series'])}

def service_diagnostics(service, run=command):
    if service not in SERVICES:
        raise ValueError('invalid_parameters')
    # Projection at Docker boundary avoids environment, mounts and health logs.
    template = '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.State.OOMKilled}}|{{.State.ExitCode}}'
    def inspect():
        values = run(['/usr/bin/docker', 'inspect', '--format', template, service]).strip().split('|')
        if len(values) != 6 or values[0] not in ('created','running','paused','restarting','removing','exited','dead') or values[1] not in ('none','starting','healthy','unhealthy'):
            raise ValueError('invalid_container_state')
        if not re.fullmatch(r'[0-9TZ:.+-]{1,40}', values[3]) or values[4] not in ('true','false'):
            raise ValueError('invalid_container_metadata')
        return {'service': service, 'container_state': values[0], 'healthcheck': values[1],
                'restart_count': int(values[2]), 'started_at': values[3],
                'oom_killed': values[4]=='true', 'exit_code': int(values[5])}
    result = collect('docker.inspect.safe_projection', inspect, ['one_allowlisted_container','docker_health_not_functional_probe'])
    if result['data']:
        row = result['data']
        result['state'] = ('failed' if row['container_state'] != 'running' or row['healthcheck']=='unhealthy'
                           else 'healthy' if row['healthcheck']=='healthy' else 'unknown')
    return {'container': result, 'functional_readiness': evidence('not_probed', None,
             coverage=['no_network_probe','no_actuators','no_credentials'])}

def load_operation(broker, change_id):
    if not isinstance(change_id, str) or not re.fullmatch('[a-f0-9]{32}', change_id):
        raise ValueError('invalid_parameters')
    row = json.loads(read_fixed(broker.state / ('change-'+change_id+'.json'), 600000))
    if row.get('kind') not in ('file', 'restart') or row.get('status') not in ('prepared','executing','applied','reverted','outcome_unknown'):
        raise ValueError('invalid_operation')
    return row

def operation_status(broker, change_id):
    row = load_operation(broker, change_id)
    data = {'operation_id': change_id, 'kind': row['kind'], 'status': row['status'],
            'created_at': utc(row['created_at']), 'expired': time.time()-row['created_at'] > 3600,
            'safe_to_repeat': row['status'] in ('applied', 'reverted'),
            'functional_behavior': 'not_validated'}
    if row['kind']=='file':
        item, current = broker.source(row['file_id'])
        current_hash = hashlib.sha256(current).hexdigest()
        data.update(file_id=row['file_id'], expected_sha256=row['base'], proposed_sha256=row['result'],
                    current_sha256=current_hash, source_matches_proposal=current_hash==row['result'], deployment='source_only')
    elif row.get('service') in SERVICES:
        data['service'] = row['service']
    else:
        raise ValueError('invalid_operation')
    return evidence('broker.proposal_and_current_source', data, coverage=['no_payload_or_backup_content','restart_completion_not_reconciled'])

def change_validate(broker, change_id, run=command):
    row = load_operation(broker, change_id)
    if row['kind']!='file' or row['status']!='prepared' or time.time()-row['created_at'] > 3600:
        raise ValueError('prepared_file_required')
    item, data = broker.source(row['file_id'])
    if hashlib.sha256(data).hexdigest()!=row['base'] or hashlib.sha256(row['after'].encode()).hexdigest()!=row['result']:
        raise ValueError('conflict')
    # No imports, evaluation, user-selected tests, configuration loading or YAML
    # constructors. Markdown/YAML have no approved validator in this release.
    result = {'operation_id': change_id, 'sha256': row['result'], 'status': 'unsupported',
              'source': 'proposal', 'deployment': 'not_deployed', 'functional_behavior': 'not_tested',
              'effects': ['syntax_parser_only','no_imports','no_network','no_service_restart'],
              'covers': [], 'does_not_cover': ['runtime_behavior','nodered_flow_generation','homeassistant_configuration','external_services']}
    if item['path'].startswith('nodered/tools/functions/') and item['path'].endswith('.js'):
        result['covers'] = ['javascript_commonjs_syntax']
        try:
            run(['/usr/bin/node', '--check', '--input-type=commonjs'], row['after'].encode())
            result['status'] = 'passed'
        except ValueError:
            result['status'] = 'failed'
        except (OSError, subprocess.SubprocessError):
            result['status'] = 'unknown'
    return evidence('node.syntax_check.stdin', result,
                    state={'passed':'healthy','failed':'failed'}.get(result['status'],'unknown'),
                    coverage=['static_only','not_persisted_not_an_apply_gate'])

def handle(broker, name, args):
    if name not in FIELDS or not isinstance(args,dict) or set(args)!={'host',*FIELDS[name]} or args['host']!='raspberry':
        raise ValueError('invalid_parameters')
    if name=='maintenance_capabilities':
        data = evidence('maintenance.schema.v1', {
            'read_tools': list(FIELDS), 'existing_tools_preserved': 11,
            'write_scope_added': [], 'allowed_services': list(SERVICES),
            'limits': ['single_host','catalog_files_only','no_arbitrary_commands_paths_destinations',
                       'no_secrets','no_actuators','no_deployment_tools_added',
                       'no_auto_updates','no_restore_execution','no_external_availability_observer'],
            'pending': ['scheduled_job_inventory','sanitized_log_pagination','backup_integrity_and_restore_evidence',
                        'resource_trends','functional_readiness','deployment_and_recovery_contracts']},
            coverage=['stage_one_partial_maintenance_interface'])
    elif name=='host_diagnostics':
        data = host_diagnostics()
    elif name=='service_diagnostics':
        data = service_diagnostics(args['service'])
    elif name=='operation_status':
        data = operation_status(broker, args['change_id'])
    else:
        data = change_validate(broker, args['change_id'])
    return {'schema_version':'1.0.0','host':'raspberry','observed_at':utc(),'evidence':data}
