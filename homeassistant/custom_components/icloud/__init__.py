"""Pinned native iCloud adapter with persisted, user-initiated authentication."""
from datetime import timedelta
import sys
import time
import types
from functools import partial
from pyicloud import PyiCloudService
from pyicloud.exceptions import PyiCloudAuthRequiredException
from requests.exceptions import ConnectionError as RequestsConnectionError, Timeout
from homeassistant.components import icloud as native
from homeassistant.components.icloud import account as core_account
from homeassistant.components.icloud.const import (
    CONF_GPS_ACCURACY_THRESHOLD, CONF_MAX_INTERVAL, CONF_WITH_FAMILY,
    PLATFORMS, STORAGE_KEY, STORAGE_VERSION)
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME, __version__ as core_version
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.config_entries import HANDLERS, SOURCE_REAUTH
from homeassistant.helpers import issue_registry
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store
from .auth_gate import AuthGate, State
from .device_owner import prepare_device_class
from .native_bridge import service_adapter, account_adapter, load_native_gate, CachedSessionBusyError
from .setup_retry import is_transport_failure
from . import loaded_proof, loaded_contract

CONFIG_SCHEMA=native.CONFIG_SCHEMA
GATES={}
PHASES={}
GuardedService=service_adapter(PyiCloudService,transport_errors=(RequestsConnectionError,Timeout,TimeoutError))
GuardedAccount=account_adapter(core_account.IcloudAccount,GATES,GuardedService,
    auth_required_errors=(PyiCloudAuthRequiredException,))
core_account.IcloudDevice=prepare_device_class(core_account,core_version)
core_account.PyiCloudService=GuardedService

def collect_loaded_contract(hass):
    now=time.time()
    try:
        request=loaded_proof.read_request(hass.config.config_dir)
        scope=loaded_contract.read_scope(hass.config.config_dir)
        if not loaded_contract.scope_allowed(scope,request,now):
            return loaded_contract.snapshot(loaded_contract.project(loaded_contract.unknown('scope_inactive')),None,None,now)
        from homeassistant.core import HassJob, Service
        module=sys.modules.get('custom_components.public_bindings')
        if type(module) is not types.ModuleType:
            raise ValueError('loaded_binding_module_unavailable')
        setup=module.__dict__.get('async_setup')
        if type(setup) is not types.FunctionType:
            raise ValueError('loaded_binding_setup_unavailable')
        entries=hass.config_entries.async_loaded_entries('icloud')
        if len(entries)>16:raise ValueError('loaded_account_limit')
        accounts=tuple(entry.runtime_data for entry in entries)
        bindings=loaded_contract.observe(hass.services,accounts,GuardedAccount,Service,HassJob,setup)
        setup_sha=loaded_proof.fingerprint({'public_bindings_setup':setup})
        container=hass.data.get('public_bindings')
        return loaded_contract.snapshot(bindings,container,setup_sha,now)
    except Exception:
        return loaded_contract.snapshot(loaded_contract.project(loaded_contract.unknown()),None,None,now)

def proof_functions():
    from .config_flow import ManualIcloudFlow
    functions={'setup':async_setup,'emit_proof':emit_proof,
            'cached_transport_classifier':is_transport_failure,
            'collect_loaded_contract':collect_loaded_contract,
            'setup_entry':async_setup_entry,'finish_recovered_reauth':finish_recovered_reauth,
            'load_native_gate':load_native_gate,
            'auth_gate_effect':AuthGate._effect,
            'account_setup':GuardedAccount.setup,'account_keep_alive':GuardedAccount.keep_alive,
            'device_owner':core_account.IcloudDevice.__init__,
            'authenticate':GuardedService.authenticate,'primary_auth':GuardedService._authenticate,
            'automatic_otp':GuardedService.request_2fa_code,
            'flow_manual':ManualIcloudFlow.async_step_manual_reauth,
            'flow_finish':ManualIcloudFlow._complete_manual_reauth}
    for cls in (AuthGate,GuardedService,GuardedAccount,ManualIcloudFlow):
        for base in cls.__mro__:
            if not base.__module__.startswith('custom_components.icloud'):continue
            for name,fn in vars(base).items():
                if isinstance(fn,property):fn=fn.fget
                if hasattr(fn,'__code__'):functions[base.__name__+'.'+name]=fn
    for module in (loaded_proof,loaded_contract):
        for name,fn in vars(module).items():
            if type(fn) is types.FunctionType and fn.__module__==module.__name__:
                functions[module.__name__.rsplit('.',1)[-1]+'.'+name]=fn
    return functions

def bindings_valid(hass):
    from .config_flow import ManualIcloudFlow
    if core_account.PyiCloudService is not GuardedService or HANDLERS.get('icloud') is not ManualIcloudFlow:
        return False
    for entry_id in PHASES:
        entry=hass.config_entries.async_get_entry(entry_id)
        if entry is None:return False
        account=getattr(entry,'runtime_data',None)
        if not isinstance(account,GuardedAccount) or not isinstance(getattr(account,'api',None),GuardedService):
            return False
        if account.api.auth_gate is not GATES.get(entry_id):return False
    return bool(PHASES)

async def emit_proof(hass, now=None):
    observation_at=time.time()
    functions=proof_functions()
    phases=list(PHASES.values())
    bindings=bindings_valid(hass)
    running=getattr(hass.state,'name',None)=='running'
    contract=collect_loaded_contract(hass)
    await hass.async_add_executor_job(
        lambda:loaded_proof.publish(hass.config.config_dir,functions,
            ha_running=running,phases=phases,bindings_valid=bindings,native_contract=contract,observation_at=observation_at))

async def async_setup(hass, config):
    result=await native.async_setup(hass,config)
    if 'icloud_manual_proof_timer' not in hass.data:
        hass.data['icloud_manual_proof_timer']=async_track_time_interval(
            hass,partial(emit_proof,hass),timedelta(seconds=30))
    await emit_proof(hass)
    return result

def finish_recovered_reauth(hass, entry):
    """Close this entry's stale repair only after fully authenticated setup."""
    account=entry.runtime_data
    gate=GATES.get(entry.entry_id)
    if (PHASES.get(entry.entry_id) != 'entry_ready'
            or not isinstance(account,GuardedAccount)
            or not isinstance(getattr(account,'api',None),GuardedService)
            or account.api.auth_gate is not gate
            or not getattr(account,'_manual_platforms_loaded',False)
            or gate.snapshot_state().reason != 'state_observed'
            or gate.state != State.VALID
            or account.api.requires_2fa or account.api.requires_2sa):
        return False
    flows=list(entry.async_get_active_flows(hass,{SOURCE_REAUTH}))
    if len(flows)>16:return False
    if any(flow.get('handler')!='icloud'
           or flow.get('context',{}).get('entry_id')!=entry.entry_id
           or flow.get('context',{}).get('source')!=SOURCE_REAUTH
           or type(flow.get('flow_id')) is not str for flow in flows):
        return False
    for flow in flows:hass.config_entries.flow.async_abort(flow['flow_id'])
    issue_registry.async_delete_issue(hass,'homeassistant',
        'config_entry_reauth_icloud_'+entry.entry_id)
    return True

async def async_setup_entry(hass, entry):
    try:GATES[entry.entry_id]=await load_native_gate(hass,entry.entry_id,Store,
        automatic_recovery=getattr(entry,'options',{}).get('automatic_session_recovery',True) is True)
    except Exception:
        raise ConfigEntryNotReady('iCloud manual authentication state unavailable') from None
    PHASES[entry.entry_id]='entry_initializing'
    data=entry.data
    account=GuardedAccount(hass,data[CONF_USERNAME],data[CONF_PASSWORD],
        Store(hass,STORAGE_VERSION,STORAGE_KEY),data[CONF_WITH_FAMILY],
        data[CONF_MAX_INTERVAL],data[CONF_GPS_ACCURACY_THRESHOLD],entry)
    entry.runtime_data=account
    account._manual_platforms_loaded=False
    if entry.unique_id is None:
        hass.config_entries.async_update_entry(entry,unique_id=data[CONF_USERNAME])
    try:
        await hass.async_add_executor_job(account.setup)
        if account.api is None or account.api.requires_2fa:
            PHASES[entry.entry_id]='entry_waiting_user'
            await emit_proof(hass)
            return True
        account.calendar_coordinator=native.IcloudCalendarCoordinator(hass,entry)
        await account.calendar_coordinator.async_refresh()
        account.reminders_coordinator=native.IcloudRemindersCoordinator(hass,entry)
        await account.reminders_coordinator.async_refresh()
        await hass.config_entries.async_forward_entry_setups(entry,PLATFORMS)
        account._manual_platforms_loaded=True
        await native.async_setup_photo_cache(hass,account)
        # A manual or silent login can leave yesterday's primary attempt
        # consumed. Close it only after native account setup, coordinators,
        # platforms and photo setup have all completed without a challenge.
        if isinstance(account.api,GuardedService):
            gate=GATES[entry.entry_id]
            if (account.api.auth_gate is not gate
                    or account.api.requires_2fa or account.api.requires_2sa):
                raise ConfigEntryNotReady('iCloud authenticated setup incomplete')
            ready=await hass.async_add_executor_job(gate.confirm_account_ready)
            if ready.reason=='operation_in_progress' or ready.state!=State.VALID:
                raise ConfigEntryNotReady('iCloud authenticated setup unconfirmed')
    except Exception as error:
        if isinstance(error,CachedSessionBusyError):
            raise ConfigEntryNotReady('iCloud cached session validation in progress') from None
        if is_transport_failure(error):
            raise ConfigEntryNotReady('iCloud transport unavailable during setup') from None
        raise
    PHASES[entry.entry_id]='entry_ready'
    finish_recovered_reauth(hass,entry)
    await emit_proof(hass)
    return True

async def async_unload_entry(hass,entry):
    account=entry.runtime_data
    if getattr(account,'_manual_platforms_loaded',False):
        if not await native.async_unload_entry(hass,entry):return False
    else:await hass.async_add_executor_job(account.cancel_fetch)
    GATES.pop(entry.entry_id,None);PHASES.pop(entry.entry_id,None)
    return True
