"""Native HA forms; every authentication effect begins with a submitted form."""
import probatio
from homeassistant.components.icloud.config_flow import IcloudFlowHandler
from homeassistant.components.icloud.const import (
    CONF_WITH_FAMILY, CONF_MAX_INTERVAL, CONF_GPS_ACCURACY_THRESHOLD,
    DEFAULT_WITH_FAMILY, DEFAULT_MAX_INTERVAL, DEFAULT_GPS_ACCURACY_THRESHOLD,
    STORAGE_KEY, STORAGE_VERSION)
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME
from homeassistant.helpers.storage import Store
from . import GATES, PHASES, GuardedService
from .native_bridge import flow_adapter, load_native_gate, bind_gate
from .auth_gate import State, diagnostic, diagnostic_exception

class ManualIcloudFlow(flow_adapter(IcloudFlowHandler), domain='icloud'):
    VERSION=1

    def _manual_form(self,errors=None):
        return self.async_show_form(step_id='manual_reauth',
            data_schema=probatio.Schema({probatio.Optional(CONF_PASSWORD):str}),
            errors=errors or {})

    async def async_step_reauth(self,entry_data):
        entry=self._get_reauth_entry()
        self._new_entry=False
        self._runtime_owner=getattr(entry,'runtime_data',None)
        self._pending_data=dict(entry_data)
        self._existing_entry_data=dict(entry_data)
        self.api=getattr(getattr(entry,'runtime_data',None),'api',None)
        await self.async_set_unique_id(entry.unique_id)
        return self._manual_form()

    async def async_step_reauth_confirm(self,user_input=None):
        # Directly reopening the native confirmation route is also display-only.
        return await self.async_step_manual_reauth(user_input)

    async def _create_guarded_client(self,key):
        gate=GATES.get(key)
        if gate is None:gate=await load_native_gate(self.hass,key,Store)
        data=self._pending_data
        cookie_store=Store(self.hass,STORAGE_VERSION,STORAGE_KEY)
        def create():
            with bind_gate(gate):
                return GuardedService(data[CONF_USERNAME],data[CONF_PASSWORD],
                    cookie_store.path,with_family=data[CONF_WITH_FAMILY])
        self.api=await self.hass.async_add_executor_job(create)

    async def async_step_user(self,user_input=None):
        if user_input is None:return self._show_setup_form()
        self._new_entry=True
        self._pending_data={CONF_USERNAME:user_input[CONF_USERNAME],CONF_PASSWORD:user_input[CONF_PASSWORD],
            CONF_WITH_FAMILY:user_input.get(CONF_WITH_FAMILY,DEFAULT_WITH_FAMILY),
            CONF_MAX_INTERVAL:DEFAULT_MAX_INTERVAL,CONF_GPS_ACCURACY_THRESHOLD:DEFAULT_GPS_ACCURACY_THRESHOLD}
        await self.async_set_unique_id(self._pending_data[CONF_USERNAME])
        self._abort_if_unique_id_configured()
        # Credentials were explicitly submitted. No provider/device enumeration
        # is used as a hidden prerequisite for entry creation.
        self.api=None
        return await self.async_step_manual_reauth({})

    async def _guarded_step(self, callback, user_input):
        if not getattr(self,'_new_entry',False) and hasattr(self,'_runtime_owner'):
            if getattr(self._get_reauth_entry(),'runtime_data',None) is not self._runtime_owner:
                return self._manual_form({'base':'no_active_challenge'})
        if getattr(self,'_manual_busy',False):
            return self._manual_form({'base':'operation_in_progress'})
        self._manual_busy=True
        try:
            result=await callback(user_input)
            if result.get('step_id')=='manual_reauth':return self._manual_form(result.get('errors'))
            return result
        except Exception as exc:
            diagnostic_exception('flow_dispatch',exc)
            return self._manual_form({'base':'state_unavailable'})
        finally:self._manual_busy=False

    async def async_step_manual_reauth(self,user_input=None):
        return await self._guarded_step(self._submit_manual_reauth,user_input)

    async def async_step_verification_code(self,user_input=None,errors=None):
        if self.api is None:return self._manual_form({'base':'no_active_challenge'})
        async def step(value):
            return await super(ManualIcloudFlow,self).async_step_verification_code(value,errors)
        return await self._guarded_step(step,user_input)

    async def async_step_trusted_device(self,user_input=None,errors=None):
        if self.api is None:return self._manual_form({'base':'no_active_challenge'})
        # The prepare step enters the display-only device form internally.
        if user_input is None:
            return await super().async_step_trusted_device(None,errors)
        async def step(value):
            return await super(ManualIcloudFlow,self).async_step_trusted_device(value,errors)
        return await self._guarded_step(step,user_input)

    async def _show_verification_code_form(self,errors):
        state=self.api.auth_gate.state
        fields={}
        if state==State.READY:
            fields[probatio.Required('request_new_code',default=False)]=bool
        elif state==State.CODE:
            fields[probatio.Optional('verification_code')]=str
        else:return self._manual_form({'base':'no_active_challenge'})
        return self.async_show_form(step_id='verification_code',
            data_schema=probatio.Schema(fields),errors=errors)

    async def _submit_manual_reauth(self,user_input=None):
        if user_input is None:return self._manual_form()
        if self.api is not None and self.api.auth_gate.state==State.UNCERTAIN:
            return self._manual_form({'base':'delivery_unknown'})
        if self.api is not None and self.api.auth_gate.state in (State.READY,State.CODE):
            if not self.api._manual_context_ready:
                return self._manual_form({'base':'no_active_challenge'})
            if self.api.auth_gate.state==State.READY and getattr(self,'_trusted_choices',None):
                return await self.async_step_trusted_device()
            return await self._show_verification_code_form({})
        diagnostic('manual_submission','submitted')
        changed_password=user_input.get(CONF_PASSWORD)
        if changed_password:
            self._pending_data[CONF_PASSWORD]=changed_password
            self.api=None
        if self.api is None:
            key=self.flow_id if getattr(self,'_new_entry',False) else self._get_reauth_entry().entry_id
            diagnostic('client_creation','started')
            try:await self._create_guarded_client(key)
            except Exception as exc:
                diagnostic_exception('client_creation',exc)
                return self._manual_form({'base':'state_unavailable'})
            diagnostic('client_creation','created')
        try:result=await super().async_step_manual_reauth(user_input)
        except Exception as exc:
            diagnostic_exception('flow_dispatch',exc)
            return self._manual_form({'base':'state_unavailable'})
        category={'manual_reauth':'manual_form','verification_code':'code_form',
                  'trusted_device':'trusted_device_form'}.get(result.get('step_id'))
        if category is None:category='completed' if result.get('type') in ('abort','create_entry') else 'other_result'
        diagnostic('flow_result',category)
        if result.get('step_id')=='manual_reauth':return self._manual_form(result.get('errors'))
        return result

    async def _complete_manual_reauth(self):
        if getattr(self,'_new_entry',False):
            return self.async_create_entry(title=self._pending_data[CONF_USERNAME],data=self._pending_data)
        entry=self._get_reauth_entry()
        self.hass.config_entries.async_update_entry(entry,data=self._pending_data)
        loaded=await self.hass.config_entries.async_reload(entry.entry_id)
        self.api=getattr(getattr(entry,'runtime_data',None),'api',None)
        if not loaded or PHASES.get(entry.entry_id)!='entry_ready':
            return self._manual_form({'base':'state_unavailable'})
        return self.async_abort(reason='reauth_successful')
