import asyncio
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('loaded_contract', Path(__file__).with_name('loaded_contract.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SECRET = 'PRIVATE_ACCOUNT_SENTINEL@example.invalid'


class ForbiddenProvider:
    @property
    def devices(self): raise AssertionError(SECRET)
    @property
    def requires_2fa(self): raise AssertionError(SECRET)
    @property
    def location(self): raise AssertionError(SECRET)
    def authenticate(self): raise AssertionError(SECRET)


class Account:
    def __init__(self, username=SECRET, api=True):
        self._username = username; self.api = ForbiddenProvider() if api else None
        self._password = '_'.join(('PRIVATE','PASSWORD','SENTINEL'))
    @property
    def username(self): raise AssertionError(SECRET)
    @property
    def devices(self): raise AssertionError(SECRET)


class Job:
    __slots__ = ('target',)
    def __init__(self, target): self.target = target


class Service:
    __slots__ = ('job',)
    def __init__(self, fn): self.job = Job(fn)


class Registry:
    def __init__(self, fn): self.services = {'call': Service(fn)}; self.downstream = True
    def async_services_for_domain(self, domain):
        assert domain == 'public_bindings'; return self.services.copy()
    def has_service(self, domain, action):
        assert (domain, action) == ('icloud', 'update'); return self.downstream
    def async_call(self, *args, **kwargs): raise AssertionError('service effect forbidden')


def setup(bindings, ready=True):
    services = bindings
    entities = {role + '_location': (role, {'target_entity_id': 'device_tracker.private_fixture_' + role}) for role in m.ROLES}
    location_target_ids = {'device_tracker.private_fixture_' + role for role in m.ROLES}
    binding_service_ready = asyncio.Event()
    if ready: binding_service_ready.set()
    async def call_binding(call):
        return services.get(call), entities, location_target_ids
    binding_service_handler = call_binding
    async def dispatch_binding(call):
        await binding_service_ready.wait()
        return await binding_service_handler(call)
    return dispatch_binding, call_binding, binding_service_ready


class ContractTest(unittest.TestCase):
    def setUp(self):
        self.bindings = {(r, 'refresh_location'): {'location_refresh_provider': 'icloud', 'target_service': 'icloud.update', 'location_refresh_public_entity_id': r + '_location', 'data': {'account': SECRET}} for r in m.ROLES}
        self.dispatch, self.handler, self.event = setup(self.bindings)
        self.registry = Registry(self.dispatch); self.accounts = (Account(),)

    def observe(self):
        return m.observe(self.registry, self.accounts, Account, Service, Job, setup)

    def test_two_loaded_contracts_and_no_private_values(self):
        value = self.observe(); self.assertEqual(value['state'], 'observed')
        for row in value['roles']:
            self.assertTrue(all(row[k] is True for k in m.FIELDS))
        exported = json.dumps(value)
        self.assertNotIn(SECRET, exported); self.assertNotIn('PRIVATE_PASSWORD_SENTINEL', exported)
        self.assertFalse(value['service_calls_executed']); self.assertFalse(value['provider_properties_accessed']); self.assertFalse(value['functional_recovery_proven'])

    def test_one_binding_absent_does_not_claim_account_or_api_absent(self):
        del self.bindings[(m.ROLES[1], 'refresh_location')]
        row = self.observe()['roles'][1]
        self.assertFalse(row['binding_loaded']); self.assertIsNone(row['matching_loaded_account']); self.assertIsNone(row['api_present'])

    def test_provider_and_target_mismatch_visible(self):
        self.bindings[(m.ROLES[0], 'refresh_location')].update(location_refresh_provider='other', target_service='other.call')
        row = self.observe()['roles'][0]
        self.assertFalse(row['provider_is_icloud']); self.assertFalse(row['target_is_expected_icloud_update'])

    def test_downstream_missing_is_distinct_from_front_registered(self):
        self.registry.downstream = False
        row = self.observe()['roles'][0]
        self.assertTrue(row['binding_loaded']); self.assertFalse(row['downstream_registered'])

    def test_front_missing_is_known_absence(self):
        self.registry.services.clear()
        row = self.observe()['roles'][0]
        self.assertFalse(row['binding_loaded']); self.assertFalse(row['handler_ready']); self.assertIsNone(row['provider_is_icloud'])

    def test_handler_not_ready_never_reads_bound_account(self):
        self.event.clear(); self.accounts = (object(),)
        row = self.observe()['roles'][0]
        self.assertFalse(row['handler_ready']); self.assertIsNone(row['binding_loaded']); self.assertIsNone(row['api_present'])

    def test_missing_matching_loaded_account(self):
        self.accounts = (Account('different@example.invalid'),)
        row = self.observe()['roles'][0]
        self.assertFalse(row['matching_loaded_account']); self.assertIsNone(row['api_present'])

    def test_multiple_matching_accounts_are_unknown(self):
        self.accounts = (Account(), Account())
        row = self.observe()['roles'][0]
        self.assertEqual(row['collection_error'], 'ambiguous_loaded_account'); self.assertIsNone(row['matching_loaded_account']); self.assertIsNone(row['api_present'])

    def test_matched_account_missing_api(self):
        self.accounts = (Account(api=False),)
        row = self.observe()['roles'][0]
        self.assertTrue(row['matching_loaded_account']); self.assertFalse(row['api_present'])

    def test_unrecognized_handler_code_is_unknown(self):
        async def other(): raise AssertionError(SECRET)
        self.registry.services['call'].job.target = other
        self.assertEqual(self.observe()['state'], 'unknown')

    def test_service_and_job_subclasses_not_adapted(self):
        class Derived(Service): pass
        self.registry.services['call'] = Derived(self.dispatch)
        self.assertEqual(self.observe()['state'], 'unknown')
        class DerivedJob(Job): pass
        self.registry.services['call'] = Service(self.dispatch)
        self.registry.services['call'].job = DerivedJob(self.dispatch)
        self.assertEqual(self.observe()['state'], 'unknown')

    def test_unknown_account_type_and_storage_are_unknown(self):
        self.accounts = (object(),)
        self.assertEqual(self.observe()['state'], 'unknown')

    def test_exact_guarded_account_type_and_unexpected_base_or_subclass(self):
        class GuardedAccount(Account): pass
        self.accounts = (GuardedAccount(),)
        guarded = m.observe(self.registry, self.accounts, GuardedAccount, Service, Job, setup)
        self.assertEqual(guarded['state'], 'observed')
        self.assertEqual(self.observe()['state'], 'unknown')
        self.accounts = (Account(),)
        self.assertEqual(m.observe(self.registry, self.accounts, GuardedAccount, Service, Job, setup)['state'], 'unknown')

    def test_invalid_location_target_not_hidden_by_other_valid_fields(self):
        self.bindings[(m.ROLES[0], 'refresh_location')]['location_refresh_public_entity_id'] = 'missing_private_target'
        row = self.observe()['roles'][0]
        self.assertFalse(row['location_target_contract_valid'])
        self.assertTrue(all(row[field] is True for field in m.FIELDS if field != 'location_target_contract_valid'))
        a = Account(); del a.__dict__['api']; self.accounts = (a,)
        self.assertEqual(self.observe()['state'], 'unknown')

    def test_malformed_bindings_do_not_coerce_objects(self):
        class Private:
            def __eq__(self, other): raise AssertionError(SECRET)
            def __repr__(self): raise AssertionError(SECRET)
        self.bindings[(m.ROLES[0], 'refresh_location')]['location_refresh_provider'] = Private()
        row = self.observe()['roles'][0]
        self.assertEqual(row['collection_error'], 'binding_contract_invalid'); self.assertIsNone(row['provider_is_icloud'])

    def test_collection_exception_does_not_export_text(self):
        def fail(_): raise RuntimeError(SECRET)
        self.registry.async_services_for_domain = fail
        value = self.observe(); self.assertEqual(value['state'], 'unknown'); self.assertNotIn(SECRET, json.dumps(value))

    def test_projection_rejects_unknown_fields_and_nonboolean_values(self):
        for field, value in [('private_account', SECRET), ('api_present', 1), ('collection_error', [SECRET])]:
            facts = m.unknown()
            facts[m.ROLES[0]][field] = value
            output = m.project(facts)
            self.assertEqual(output['roles'][0]['state'], 'unknown'); self.assertNotIn(SECRET, json.dumps(output))

    def test_limits_prevent_unbounded_account_or_registry_walk(self):
        self.accounts = tuple(Account() for _ in range(17))
        self.assertEqual(self.observe()['state'], 'unknown')
        self.accounts = (Account(),)
        self.registry.services.update({str(i): None for i in range(17)})
        self.assertEqual(self.observe()['state'], 'unknown')

    def test_expected_code_is_actual_loaded_setup_code(self):
        codes = m.nested_codes(setup)
        self.assertIs(self.dispatch.__code__, codes['dispatch_binding'])
        self.assertIs(self.handler.__code__, codes['call_binding'])
        with self.assertRaises(ValueError): m.nested_codes(lambda: None)


if __name__ == '__main__': unittest.main()
