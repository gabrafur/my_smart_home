"""Synthetic facts and optional real HA decorators; never residential config."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/raspberry-mcp/runtime-source/ha-backup-profile'
SPEC = importlib.util.spec_from_file_location('backup_profile_projection', SOURCE / 'projection.py')
projection = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(projection)
AID = 'onedrive.fixture'
PRIVATE = 'SYNTHETIC_VALUE_THAT_MUST_NEVER_LEAVE_THE_PRODUCER'


class Secret(str):
    def __str__(self):
        raise AssertionError('secret coercion')
    def __repr__(self):
        raise AssertionError('secret repr')
    def encode(self, *args, **kwargs):
        raise AssertionError('secret encoding')


def fixture():
    create = NS(agent_ids=[AID], password=Secret(PRIVATE), include_database=False,
                include_all_addons=False, include_addons=None, include_folders=None)
    data = NS(create_backup=create, retention=NS(copies=None, days=None),
              agents={AID: NS(protected=True, retention=None)})
    manager = NS(config=NS(data=data), backup_agents={AID: NS(domain='onedrive', agent_id=AID)})
    entries = [NS(domain='onedrive', disabled_by=None, unique_id='fixture', options={})]
    return manager, entries


class Projection(unittest.TestCase):
    def test_only_selected_facts_are_returned_without_coercing_or_copying_the_secret(self):
        manager, entries = fixture()
        value = projection.project_profile(manager, entries)
        wire = json.dumps(value)
        self.assertNotIn(PRIVATE, wire)
        self.assertNotIn('"password"', wire)
        self.assertTrue(value['password_configured'])
        self.assertEqual(value['include_addons'], [])
        self.assertEqual(value['include_folders'], [])
        self.assertTrue(value['native_retention']['all_agents_covered'])
        self.assertEqual(value['native_retention']['agents'], [{'agent_id': AID, 'copies': None, 'days': None}])
        self.assertIs(manager.config.data.create_backup.password.__class__, Secret)

    def test_missing_or_empty_password_is_a_false_fact_without_a_fabricated_repair(self):
        for password in (None, ''):
            manager, entries = fixture();manager.config.data.create_backup.password=password
            self.assertFalse(projection.project_profile(manager, entries)['password_configured'])

    def test_global_and_agent_retention_include_loaded_and_inactive_configured_agents(self):
        manager, entries = fixture();manager.config.data.retention.copies=4
        manager.config.data.agents['backup.inactive']=NS(protected=False, retention=NS(copies=None, days=7))
        manager.backup_agents['backup.local']=NS(domain='backup', agent_id='backup.local')
        value=projection.project_profile(manager, entries)
        self.assertEqual(value['native_retention']['global'], {'copies':4,'days':None})
        rows={r['agent_id']:r for r in value['native_retention']['agents']}
        self.assertEqual(rows[AID]['copies'],4)
        self.assertEqual(rows['backup.local']['copies'],4)
        self.assertEqual(rows['backup.inactive']['days'],7)

    def test_nonempty_coverage_and_unsafe_provider_flags_remain_facts_for_consumer_gates(self):
        manager, entries=fixture();create=manager.config.data.create_backup
        create.include_database=True;create.include_all_addons=True;create.include_addons=['fixture_addon'];create.include_folders=['media']
        entries[0].options['delete_permanently']=True;manager.config.data.agents[AID].protected=False
        value=projection.project_profile(manager, entries)
        self.assertTrue(value['include_database']);self.assertTrue(value['include_all_addons'])
        self.assertEqual(value['include_addons'],['fixture_addon']);self.assertTrue(value['delete_permanently'])
        self.assertFalse(value['provider_protected'])

    def test_unknown_inventory_invalid_selection_and_duplicate_entries_are_unavailable(self):
        changes=[lambda m,e:m.backup_agents.clear(),lambda m,e:m.config.data.agents.clear(),
          lambda m,e:m.config.data.create_backup.agent_ids.append('onedrive.other'),
          lambda m,e:e.append(e[0]),lambda m,e:setattr(e[0],'disabled_by','user'),
          lambda m,e:setattr(e[0],'unique_id','other'),lambda m,e:setattr(m.backup_agents[AID],'agent_id','onedrive.other')]
        for change in changes:
            manager,entries=fixture();change(manager,entries)
            with self.assertRaises(projection.ProfileUnavailable):projection.project_profile(manager,entries)

    def test_bool_or_negative_retention_and_unknown_field_types_do_not_become_disabled(self):
        for bad in (True,-1,0,'7'):
            manager,entries=fixture();manager.config.data.retention.days=bad
            with self.assertRaises(projection.ProfileUnavailable):projection.project_profile(manager,entries)
        manager,entries=fixture();entries[0].options['delete_permanently']='false'
        with self.assertRaises(projection.ProfileUnavailable):projection.project_profile(manager,entries)


HAS_HA = importlib.util.find_spec('probatio') is not None and importlib.util.find_spec('homeassistant.core') is not None


@unittest.skipUnless(HAS_HA, 'real Home Assistant libraries required in an isolated fixture')
class NativeHandler(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec=importlib.util.spec_from_file_location('fixture_native_backup_profile', SOURCE/'__init__.py',
          submodule_search_locations=[str(SOURCE)])
        cls.module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=cls.module;spec.loader.exec_module(cls.module)

    def setUp(self):
        from homeassistant.components.backup.config import AgentConfig, CreateBackupConfig, RetentionConfig
        manager,entries=fixture()
        manager.config.data.create_backup=CreateBackupConfig(agent_ids=[AID],password=Secret(PRIVATE),include_database=False)
        manager.config.data.retention=RetentionConfig(copies=None,days=None)
        manager.config.data.agents={AID:AgentConfig(protected=True)}
        self.manager=manager;self.entries=entries
        self.hass=NS(data={self.module.DATA_MANAGER:manager},config_entries=NS(async_entries=lambda domain:entries))
        self.results=[];self.errors=[]
        self.connection=NS(user=NS(is_admin=True),send_result=lambda i,v:self.results.append((i,v)),
          send_error=lambda *args:self.errors.append(args))

    def test_actual_HA_registration_is_opt_in_and_only_registers_the_readonly_method(self):
        self.assertFalse(asyncio.run(self.module.async_setup(self.hass,{})))
        self.assertNotIn('websocket_api',self.hass.data)
        self.assertTrue(asyncio.run(self.module.async_setup(self.hass,{self.module.DOMAIN:{}})))
        self.assertEqual(list(self.hass.data['websocket_api']),[self.module.METHOD])
        registered=self.hass.data['websocket_api'][self.module.METHOD][0]
        registered(self.hass,self.connection,{'id':1,'type':self.module.METHOD})
        self.assertEqual(self.errors,[]);self.assertEqual(len(self.results),1)
        self.assertTrue(self.results[0][1]['password_configured'])
        self.assertNotIn(PRIVATE,json.dumps(self.results))

    def test_actual_HA_admin_decorator_prevents_access_before_any_config_read(self):
        from homeassistant.exceptions import Unauthorized
        for user in (None,NS(is_admin=False)):
            self.connection.user=user
            with self.assertRaises(Unauthorized):self.module.handle_profile(NS(),self.connection,{'id':1,'type':self.module.METHOD})
        self.assertEqual(self.results,[]);self.assertEqual(self.errors,[])

    def test_unknown_native_exception_is_not_returned_or_logged(self):
        class Broken:
            @property
            def data(self):raise RuntimeError(PRIVATE)
        self.manager.config=Broken()
        self.module.handle_profile(self.hass,self.connection,{'id':1,'type':self.module.METHOD})
        self.assertEqual(self.results,[])
        self.assertEqual(self.errors,[(1,'backup_profile_unavailable','Backup metadata profile is unavailable')])
        self.assertNotIn(PRIVATE,json.dumps(self.errors))

    def test_request_does_not_accept_commands_paths_or_credentials(self):
        self.module.handle_profile(NS(),self.connection,{'id':1,'type':self.module.METHOD,'password':PRIVATE})
        self.assertEqual(self.results,[])
        self.assertEqual(self.errors,[(1,'invalid_format','Backup metadata request is invalid')])


if __name__=='__main__':unittest.main()
