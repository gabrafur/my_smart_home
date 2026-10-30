"""Compose the existing broker without changing legacy tools or write scopes."""
import importlib.util
import sys

sys.path.insert(0, '/usr/local/lib/raspberry-mcp-storage')
import catalog
import client
spec = importlib.util.spec_from_file_location('existing_storage_prior_broker',
        '/usr/local/lib/raspberry-repair-control/repair-broker.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class Broker(legacy.Broker):
    def handle(self, name, args):
        if name in catalog.TOOLS and type(args) is dict and type(args.get('action')) is str and args['action'].startswith('storage_'):
            return client.request(name, args)
        if name in ('storage_metadata_read', 'maintenance_capabilities'):
            if args != {'host': 'raspberry'}:
                raise ValueError('storage_scope_refused')
            observation = client.request('storage_metadata_observe', args)
            if name == 'storage_metadata_read':
                c = catalog.catalogue()
                c['current_admission'] = observation.get('maintenance_admission')
                return {'storage_health': legacy.health.storage_health(),
                        'storage_maintenance_catalogue': c, 'storage_metadata_refresh': observation}
            value = super().handle(name, args)
            target = value['evidence']['data']
            target['storage_health'] = legacy.health.storage_health()
            target['storage_maintenance_catalogue'] = catalog.catalogue()
            target['storage_maintenance_catalogue']['current_admission'] = observation.get('maintenance_admission')
            target['storage_metadata_refresh'] = observation
            target['operating_policy_v1'] = legacy.health.operating_policy_v1(target, target.get('operating_admission_snapshot_v1'))
            return value
        return super().handle(name, args)


if __name__ == '__main__':
    # Same setup as the current repair broker; no FIELDS, device or arbitrary
    # operation expansion. Routing validates storage action and operation ID.
    import runpy
    # The legacy main routine assigns operations.Broker. Preserve the class
    # through one fixed wrapper of operations.main instead of copying its setup.
    original = legacy.operations.main
    def main():
        legacy.operations.Broker = Broker
        legacy.operations.FIELDS['storage_metadata_read'] = ()
        return original()
    legacy.operations.main = main
    runpy.run_path('/usr/local/lib/raspberry-repair-control/repair-broker.py', run_name='__main__')
