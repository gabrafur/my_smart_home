"""Fixed isolated image check: no production configuration, network or login."""
import json,resource,signal,sys

REVIEWED_PYICLOUD='2026.10.1'
REVIEWED_PYICLOUD_SOURCE='4bff2f4fcdda0af1644d9a76367e86c6df17c467c21eab3dc300aa93fc6e80d6'

def main():
    resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))
    resource.setrlimit(resource.RLIMIT_CPU,(30,30))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_FSIZE,(0,0))
    signal.alarm(90)
    sys.dont_write_bytecode=True
    import importlib.metadata,importlib.util,runpy
    from homeassistant.const import __version__
    from homeassistant.components.icloud import account
    adapter=runpy.run_path('/review/device_owner.py')
    expected_pyicloud = {'2026.10.1':'2.7.0','2026.10.4':'2.7.0','2026.11.0':'2026.10.1','2026.11.1':'2026.10.1','2026.11.2':'2026.10.1'}.get(__version__)
    admission='reviewed_version'
    if expected_pyicloud is None:
        # A version outside the list needs the reviewed iCloud and pyicloud bytes.
        if not adapter['native_source_reviewed'](account):
            raise RuntimeError('unsupported_icloud_core_version')
        expected_pyicloud=REVIEWED_PYICLOUD
        admission='identical_reviewed_source'
        root=importlib.util.find_spec('pyicloud').origin.rpartition('/')[0]
        if adapter['tree_digest'](root,('__pycache__',))!=REVIEWED_PYICLOUD_SOURCE:
            raise RuntimeError('unsupported_pyicloud_version')
    if importlib.metadata.version('pyicloud')!=expected_pyicloud:
        raise RuntimeError('unsupported_pyicloud_version')
    reviewed=adapter['prepare_device_class'](account,__version__)
    if not issubclass(reviewed,account.IcloudDevice):
        raise RuntimeError('icloud_adapter_type_changed')
    return {'state':'compatible','core_version':__version__,'pyicloud':expected_pyicloud,'admission':admission,
        'constructor_sha256':adapter['EXPECTED_INIT'],'network_enabled':False,
        'production_configuration_mounted':False,'apple_authentication_called':False}

if __name__=='__main__':
    try:print(json.dumps(main()))
    except Exception as exc:
        reason=str(exc)if type(exc)is RuntimeError and str(exc)in {
            'unsupported_icloud_core_version','icloud_constructor_changed',
            'unsupported_pyicloud_version','icloud_adapter_type_changed'}else'compatibility_unconfirmed'
        print(json.dumps({'state':'blocked','reason':reason,'raw_error_withheld':True}));raise SystemExit(1)
