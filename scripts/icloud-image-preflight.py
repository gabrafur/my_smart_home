"""Fixed isolated image check: no production configuration, network or login."""
import json,resource,signal,sys

def main():
    resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))
    resource.setrlimit(resource.RLIMIT_CPU,(30,30))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_FSIZE,(0,0))
    signal.alarm(90)
    sys.dont_write_bytecode=True
    import importlib.metadata,runpy
    from homeassistant.const import __version__
    from homeassistant.components.icloud import account
    adapter=runpy.run_path('/review/device_owner.py')
    if importlib.metadata.version('pyicloud')!='2.7.0':
        raise RuntimeError('unsupported_pyicloud_version')
    reviewed=adapter['prepare_device_class'](account,__version__)
    if not issubclass(reviewed,account.IcloudDevice):
        raise RuntimeError('icloud_adapter_type_changed')
    return {'state':'compatible','core_version':__version__,'pyicloud':'2.7.0',
        'constructor_sha256':adapter['EXPECTED_INIT'],'network_enabled':False,
        'production_configuration_mounted':False,'apple_authentication_called':False}

if __name__=='__main__':
    try:print(json.dumps(main()))
    except Exception as exc:
        reason=str(exc)if type(exc)is RuntimeError and str(exc)in {
            'unsupported_icloud_core_version','icloud_constructor_changed',
            'unsupported_pyicloud_version','icloud_adapter_type_changed'}else'compatibility_unconfirmed'
        print(json.dumps({'state':'blocked','reason':reason,'raw_error_withheld':True}));raise SystemExit(1)
