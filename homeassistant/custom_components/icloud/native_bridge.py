"""Candidate native adapters. Imported by tests only; no installation entrypoint.

Factories wrap the reviewed native interfaces without storing account data.
Home Assistant wiring and translations must be reviewed before deployment.
"""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
import re
from .auth_gate import AuthGate, Outcome, State, diagnostic
from .setup_retry import is_transport_failure

BOUND_GATE = ContextVar('icloud_manual_gate', default=None)

class CachedSessionTransportError(ConnectionError):
    """Typed transient failure; no provider/account text and no auth permission."""

class CachedSessionBusyError(RuntimeError):
    """Another guarded operation owns validation; no new request or repair."""

class ManualActionRequired(Exception):
    """Static signal; never contains an account or provider response."""

@contextmanager
def bind_gate(gate):
    token = BOUND_GATE.set(gate)
    try: yield
    finally: BOUND_GATE.reset(token)

async def load_native_gate(hass, entry_id, store_factory):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', entry_id):
        raise ValueError('invalid_entry_key')
    store = store_factory(hass, 1, 'icloud_manual_reauth.' + entry_id)
    saved = await store.async_load()
    loop = asyncio.get_running_loop()
    def persist(row):
        try: current = asyncio.get_running_loop()
        except RuntimeError: current = None
        if current is loop: raise RuntimeError('auth_effect_requires_executor')
        pending = asyncio.run_coroutine_threadsafe(store.async_save(row), loop)
        try: pending.result(timeout=10)
        except BaseException:
            pending.cancel(); raise
    return AuthGate(persist, saved)

def service_adapter(base, *, transport_errors=()):
    class GuardedService(base):
        def __init__(self, *args, **kwargs):
            self.auth_gate = BOUND_GATE.get()
            if self.auth_gate is None: raise ManualActionRequired('gate_not_loaded')
            self._explicit_auth = ContextVar('explicit_icloud_auth', default=False)
            self._cached_validation = ContextVar('cached_icloud_validation', default=False)
            self._manual_context_ready = False
            kwargs.update(authenticate=False, pause_2fa=True)
            super().__init__(*args, **kwargs)
            # Native account.setup expects an API object even when reauth is needed.
            try: self.authenticate()
            except ManualActionRequired: pass

        @property
        def requires_2fa(self):
            # Makes native setup/update_devices stop before private service access.
            if not self._explicit_auth.get() and not self._cached_validation.get():
                snapshot = self.auth_gate.snapshot_state()
                if snapshot.reason == 'operation_in_progress':
                    raise CachedSessionBusyError('cached_session_operation_in_progress')
                state = snapshot.state
            else:
                # These contexts already own the gate effect; never relock it.
                state = self.auth_gate.state
            return state != State.VALID or super().requires_2fa

        def _validate_token(self):
            if self._explicit_auth.get():
                return super()._validate_token()
            try:
                return super()._validate_token()
            except Exception as exc:
                # The native reuse helper swallows APIResponseException. Convert
                # typed transport before that catch, preserving auth/unknown errors.
                if isinstance(exc, transport_errors) or is_transport_failure(exc):
                    raise CachedSessionTransportError('cached_session_transport_unavailable') from None
                raise

        def authenticate(self, force_refresh=False, service=None, pause_2fa=None):
            if self._explicit_auth.get():
                return super().authenticate(force_refresh=force_refresh, service=service, pause_2fa=True)
            def cached_only():
                token = self._cached_validation.set(True)
                try:
                    try:
                        valid = super(GuardedService, self)._try_reuse_cached_session(False, True)
                        if not valid: return Outcome.EXPIRED
                        if super(GuardedService, self).requires_2fa or super(GuardedService, self).requires_2sa:
                            return Outcome.CHALLENGE
                        super(GuardedService, self)._update_state()
                        return Outcome.VALID
                    except Exception as exc:
                        if isinstance(exc, transport_errors) or is_transport_failure(exc):
                            return Outcome.TRANSPORT
                        raise
                finally:
                    self._cached_validation.reset(token)
            result = self.auth_gate.cached_session(cached_only)
            if result.reason == 'operation_in_progress':
                raise CachedSessionBusyError('cached_session_operation_in_progress')
            if result.reason == Outcome.TRANSPORT:
                raise CachedSessionTransportError('cached_session_transport_unavailable') from None
            if result.state != State.VALID:
                raise ManualActionRequired(result.reason)

        def _authenticate(self, *args, **kwargs):
            if not self._explicit_auth.get(): raise ManualActionRequired('primary_auth_requires_user')
            return super()._authenticate(*args, **kwargs)

        def _try_service_one_factor_login(self, *args, **kwargs):
            if not self._explicit_auth.get(): return False
            return super()._try_service_one_factor_login(*args, **kwargs)

        def _srp_authentication(self, *args, **kwargs):
            if not self._explicit_auth.get(): raise ManualActionRequired('primary_auth_requires_user')
            return super()._srp_authentication(*args, **kwargs)

        def _authenticate_with_credentials_service(self, *args, **kwargs):
            if not self._explicit_auth.get(): raise ManualActionRequired('primary_auth_requires_user')
            return super()._authenticate_with_credentials_service(*args, **kwargs)

        def _login_with_paused_token(self):
            result = super()._login_with_paused_token()
            if result and super().requires_2fa and not self._auth_data:
                diagnostic('delivery_context', 'paused_token_context_missing')
            return result

        def request_2fa_code(self):
            return False

        def _request_sms_2fa_code(self, *args, **kwargs):
            # Native bridge failures may otherwise trigger a second delivery
            # over SMS. An uncertain prompt must be reconciled first.
            if not self._explicit_auth.get() or getattr(self, '_manual_route', None) != 'sms_route':
                raise ManualActionRequired('delivery_fallback_requires_reconciliation')
            return super()._request_sms_2fa_code(*args, **kwargs)

        def send_verification_code(self, *args, **kwargs):
            return False

        def validate_2fa_code(self, *args, **kwargs):
            if not self._explicit_auth.get(): return False
            return super().validate_2fa_code(*args, **kwargs)

        def validate_verification_code(self, *args, **kwargs):
            if not self._explicit_auth.get(): return False
            return super().validate_verification_code(*args, **kwargs)

        @property
        def native_requires_2fa(self):
            return super().requires_2fa

        @property
        def native_requires_2sa(self):
            return super().requires_2sa

        def _manual(self, callback):
            token = self._explicit_auth.set(True)
            try: return callback()
            finally: self._explicit_auth.reset(token)

        def prepare_manual_session(self):
            def action():
                try:
                    self._manual_context_ready = False
                    self._manual(lambda: super(GuardedService, self).authenticate(force_refresh=True, pause_2fa=True))
                    if super(GuardedService, self).requires_2fa:
                        diagnostic('delivery_context', 'context_loaded' if self._auth_data else 'context_missing')
                        # A successful paused-token login can skip this native
                        # metadata GET. Load fresh options for this explicit
                        # preparation only; this method does not deliver a code.
                        self._auth_data = self._manual(lambda: super(GuardedService, self)._get_mfa_auth_options())
                        route = self._manual_delivery_route()
                        self._manual_route = route
                        diagnostic('delivery_context', route)
                        if route == 'security_key_required': return Outcome.SECURITY_KEY
                        if route == 'context_incomplete': return Outcome.NO_CONTEXT
                        if route == 'delivery_unavailable': return Outcome.NO_ROUTE
                        self._manual_context_ready = True
                        return Outcome.CHALLENGE
                    if super(GuardedService, self).requires_2sa:
                        self._manual_context_ready = True
                        return Outcome.CHALLENGE
                    return Outcome.VALID
                except transport_errors: return Outcome.TRANSPORT
            return self.auth_gate.submit('prepare_session', action, explicit_submission=True)

        def _manual_delivery_route(self):
            if self._auth_data.get('fsaChallenge') or self.security_key_names:
                return 'security_key_required'
            if self._supports_trusted_device_bridge(): return 'trusted_device_route'
            if self._can_request_sms_2fa_code(): return 'sms_route'
            if not self._auth_data: return 'context_incomplete'
            context = self._current_hsa2_boot_context()
            if context.auth_initial_route == 'auth/bridge/step':
                return 'context_incomplete'
            if not (context.auth_initial_route or context.auth_factors
                    or context.phone_number_verification or context.bridge_initiate_data
                    or self._auth_data.get('mode')):
                return 'context_incomplete'
            return 'delivery_unavailable'

        def request_manual_2fa_code(self):
            if not self._manual_context_ready: return self.auth_gate.result('no_active_challenge')
            def action():
                try:
                    if self._manual_delivery_route() != self._manual_route: return Outcome.NO_CONTEXT
                    return Outcome.SENT if self._manual(lambda: super(GuardedService, self).request_2fa_code()) else Outcome.NO_ROUTE
                except transport_errors: return Outcome.TRANSPORT
            return self.auth_gate.submit('request_challenge', action, explicit_submission=True)

        def send_manual_2sa_code(self, device):
            if not self._manual_context_ready: return self.auth_gate.result('no_active_challenge')
            def action():
                try: return Outcome.SENT if self._manual(lambda: super(GuardedService, self).send_verification_code(device)) else Outcome.NO_ROUTE
                except transport_errors: return Outcome.TRANSPORT
            return self.auth_gate.submit('request_challenge', action, explicit_submission=True)

        def verify_manual_2fa_code(self, code):
            if not code: return self.auth_gate.result('empty_code')
            if not self._manual_context_ready: return self.auth_gate.result('no_active_challenge')
            def action():
                try: return Outcome.VALID if self._manual(lambda: super(GuardedService, self).validate_2fa_code(code)) else Outcome.INVALID_CODE
                except transport_errors: return Outcome.TRANSPORT
            return self.auth_gate.submit('verify_code', action, explicit_submission=True)

        def verify_manual_2sa_code(self, device, code):
            if not code: return self.auth_gate.result('empty_code')
            if not self._manual_context_ready: return self.auth_gate.result('no_active_challenge')
            def action():
                try: return Outcome.VALID if self._manual(lambda: super(GuardedService, self).validate_verification_code(device, code)) else Outcome.INVALID_CODE
                except transport_errors: return Outcome.TRANSPORT
            return self.auth_gate.submit('verify_code', action, explicit_submission=True)
    return GuardedService

def account_adapter(base, gates, client_factory, *, auth_required_errors=()):
    class GuardedAccount(base):
        def setup(self):
            gate = gates[self._config_entry.entry_id]
            snapshot = gate.snapshot_state()
            if snapshot.reason == 'operation_in_progress':
                raise CachedSessionBusyError('cached_session_operation_in_progress')
            if snapshot.state not in (State.PROBE, State.VALID):
                with bind_gate(gate):
                    self.api = client_factory(self._username, self._password, self._icloud_dir.path, with_family=self._with_family)
                self._require_reauth(); return
            with bind_gate(gate):
                try: return super().setup()
                except auth_required_errors:
                    # A cached session can pass validation but fail at devices.
                    # Persist the manual gate before offering reauthentication.
                    gate.record(State.USER)
                    self._require_reauth()
                except ManualActionRequired:
                    self._require_reauth()

        def keep_alive(self, now=None):
            gate = gates[self._config_entry.entry_id]
            if gate.state not in (State.PROBE, State.VALID): return
            with bind_gate(gate):
                try: return super().keep_alive(now)
                except (CachedSessionTransportError, CachedSessionBusyError):
                    # The next existing native cycle may try cached validation.
                    # Never retry now, update devices, or open a repair here.
                    return
                except ManualActionRequired:
                    if gate.state != State.VALID: self._require_reauth()
    return GuardedAccount

def flow_adapter(base):
    class GuardedFlow(base):
        async def _complete_manual_reauth(self):
            entry = self._get_reauth_entry()
            await self.hass.config_entries.async_reload(entry.entry_id)
            return self.async_abort(reason='reauth_successful')

        async def async_step_reauth(self, entry_data):
            # No authentication or trusted-device lookup merely on opening repair.
            self._existing_entry_data = dict(entry_data)
            self.api = self._get_reauth_entry().runtime_data.api
            return self.async_show_form(step_id='manual_reauth', errors={})

        async def async_step_manual_reauth(self, user_input=None):
            if user_input is None: return self.async_show_form(step_id='manual_reauth', errors={})
            if self.api is None:
                return self.async_show_form(step_id='manual_reauth', errors={'base':'primary_authentication_required'})
            result = await self.hass.async_add_executor_job(self.api.prepare_manual_session)
            if result.reason == Outcome.CHALLENGE:
                if not self.api.native_requires_2fa and self.api.native_requires_2sa:
                    # Only reached after the explicit prepare-session submission.
                    self._trusted_choices = await self.hass.async_add_executor_job(getattr, self.api, 'trusted_devices')
                    return await self.async_step_trusted_device()
                self._manual_code_kind = '2fa'
                return await self._show_verification_code_form({})
            if result.state == State.VALID:
                return await self._complete_manual_reauth()
            return self.async_show_form(step_id='manual_reauth', errors={'base':result.reason})

        async def async_step_trusted_device(self, user_input=None, errors=None):
            if self.api.auth_gate.state != State.READY:
                return self.async_show_form(step_id='manual_reauth', errors={'base': 'no_active_challenge'})
            choices = getattr(self, '_trusted_choices', [])
            if not choices:
                return self.async_show_form(step_id='manual_reauth', errors={'base':'no_active_challenge'})
            labels = {i:device.get('deviceName', 'Trusted device') for i,device in enumerate(choices)}
            if user_input is None: return await self._show_trusted_device_form(labels, errors or {})
            try:
                index = int(user_input['trusted_device'])
                if index < 0 or index >= len(choices): raise ValueError()
            except (KeyError, TypeError, ValueError):
                return await self._show_trusted_device_form(labels, {'base':'invalid_selection'})
            self._trusted_device = choices[index]
            result = await self.hass.async_add_executor_job(self.api.send_manual_2sa_code, self._trusted_device)
            if result.state != State.CODE:
                return self.async_show_form(step_id='manual_reauth', errors={'base': result.reason})
            self._manual_code_kind = '2sa'
            return await self._show_verification_code_form({})

        async def async_step_verification_code(self, user_input=None, errors=None):
            state = self.api.auth_gate.state
            if state not in (State.READY, State.CODE) or not self.api._manual_context_ready:
                reason = 'delivery_unknown' if state == State.UNCERTAIN else 'no_active_challenge'
                return self.async_show_form(step_id='manual_reauth', errors={'base': reason})
            if user_input is None: return await self._show_verification_code_form(errors or {})
            if user_input.get('request_new_code'):
                if state != State.READY:
                    return await self._show_verification_code_form({'base': 'challenge_already_sent'})
                if getattr(self, '_manual_code_kind', '2fa') == '2sa':
                    result = await self.hass.async_add_executor_job(self.api.send_manual_2sa_code, self._trusted_device)
                else:
                    result = await self.hass.async_add_executor_job(self.api.request_manual_2fa_code)
                if result.state != State.CODE:
                    reason = 'delivery_unknown' if result.state == State.UNCERTAIN else result.reason
                    return self.async_show_form(step_id='manual_reauth', errors={'base': reason})
                return await self._show_verification_code_form({})
            if state != State.CODE:
                return await self._show_verification_code_form({'base':'challenge_not_sent'})
            code = user_input.get('verification_code', '')
            if not code: return await self._show_verification_code_form({'base':'empty_code'})
            if getattr(self, '_manual_code_kind', '2fa') == '2sa':
                result = await self.hass.async_add_executor_job(self.api.verify_manual_2sa_code, self._trusted_device, code)
            else:
                result = await self.hass.async_add_executor_job(self.api.verify_manual_2fa_code, code)
            if result.state == State.VALID: return await self._complete_manual_reauth()
            if result.state != State.CODE:
                reason = 'delivery_unknown' if result.state == State.UNCERTAIN else result.reason
                return self.async_show_form(step_id='manual_reauth', errors={'base': reason})
            return await self._show_verification_code_form({'base':result.reason})
    return GuardedFlow
