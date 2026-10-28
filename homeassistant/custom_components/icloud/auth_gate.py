"""Persisted authentication policy; challenge delivery always needs user action.

Only typed outcomes belong here, never credentials, provider responses or OTPs.
"""
from dataclasses import dataclass
from enum import Enum
from typing import Callable
from threading import Lock
from datetime import datetime, timezone
import json
import logging

_DIAGNOSTIC_LOGGER = logging.getLogger(__name__)
_DIAGNOSTIC_STAGES = frozenset({
    'manual_submission', 'client_creation', 'flow_result', 'flow_dispatch',
    'prepare_session', 'request_challenge', 'verify_code',
    'persist_before', 'persist_after',
    'delivery_context',
    'silent_session_recovery',
})
_DIAGNOSTIC_CATEGORIES = frozenset({
    'submitted', 'started', 'created', 'manual_form', 'code_form',
    'trusted_device_form', 'completed', 'other_result',
    'session_valid', 'session_expired', 'challenge_required', 'challenge_sent',
    'delivery_unavailable', 'invalid_code', 'primary_authentication_required',
    'provider_rate_limited', 'transport_unavailable', 'unclassified_failure',
    'provider_api_exception', 'provider_login_exception', 'provider_auth_required',
    'provider_2fa_required', 'provider_service_not_activated',
    'local_guard_rejection', 'local_type_error', 'local_value_error',
    'local_key_error', 'local_runtime_error', 'local_os_error',
    'context_missing', 'context_loaded', 'context_incomplete',
    'trusted_device_route', 'sms_route', 'security_key_required',
    'delivery_context_unavailable', 'delivery_unknown',
    'paused_token_context_missing',
})
_EXCEPTION_CATEGORIES = {
    ('pyicloud.exceptions', 'PyiCloudAPIResponseException'): 'provider_api_exception',
    ('pyicloud.exceptions', 'PyiCloudFailedLoginException'): 'provider_login_exception',
    ('pyicloud.exceptions', 'PyiCloudAuthRequiredException'): 'provider_auth_required',
    ('pyicloud.exceptions', 'PyiCloud2FARequiredException'): 'provider_2fa_required',
    ('pyicloud.exceptions', 'PyiCloudServiceNotActivatedException'): 'provider_service_not_activated',
    ('custom_components.icloud.native_bridge', 'ManualActionRequired'): 'local_guard_rejection',
    ('builtins', 'TypeError'): 'local_type_error',
    ('builtins', 'ValueError'): 'local_value_error',
    ('builtins', 'KeyError'): 'local_key_error',
    ('builtins', 'RuntimeError'): 'local_runtime_error',
    ('builtins', 'OSError'): 'local_os_error',
    ('builtins', 'TimeoutError'): 'transport_unavailable',
}
for _name in ('ConnectionError', 'Timeout', 'ConnectTimeout', 'ReadTimeout'):
    _EXCEPTION_CATEGORIES[('requests.exceptions', _name)] = 'transport_unavailable'


def diagnostic(stage, category, http_status=None):
    """Only four allowlisted fields; failures never change authentication."""
    try:
        if type(stage) is not str or stage not in _DIAGNOSTIC_STAGES:
            return
        if type(category) is not str or category not in _DIAGNOSTIC_CATEGORIES:
            return
        if type(http_status) is not int or not 100 <= http_status <= 599:
            http_status = None
        row = {'timestamp': datetime.now(timezone.utc).isoformat(),
               'stage': stage, 'category': category, 'http_status': http_status}
        _DIAGNOSTIC_LOGGER.warning('ICLOUD_MANUAL_DIAGNOSTIC %s',
                                   json.dumps(row, sort_keys=True))
    except Exception:
        # Diagnostics must not grant/repeat authentication or change its result.
        return


def diagnostic_exception(stage, exc):
    """Never stringify exceptions or access reason/args/body/headers/cookies."""
    try:
        kind = type(exc)
        category = _EXCEPTION_CATEGORIES.get(
            (kind.__module__, kind.__name__), 'unclassified_failure')
        status = None
        # Only public numeric metadata of an actual Requests Response instance.
        # Do not invoke exception/response properties, __str__, or __repr__.
        data = object.__getattribute__(exc, '__dict__')
        response = data.get('response') if type(data) is dict else None
        if (type(response).__module__, type(response).__name__) == ('requests.models', 'Response'):
            fields = object.__getattribute__(response, '__dict__')
            if type(fields) is dict:
                status = fields.get('status_code')
        diagnostic(stage, category, status)
    except Exception:
        diagnostic(stage, 'unclassified_failure')

class State(str, Enum):
    PROBE = 'probe_cached_session'
    VALID = 'session_valid'
    USER = 'user_action_required'
    CODE = 'awaiting_user_code'
    READY = 'challenge_available'
    UNCERTAIN = 'delivery_unknown'
    PRIMARY = 'primary_authentication_required'
    LIMITED = 'provider_rate_limited'

class Outcome(str, Enum):
    VALID = 'session_valid'
    EXPIRED = 'session_expired'
    CHALLENGE = 'challenge_required'
    SENT = 'challenge_sent'
    NO_ROUTE = 'delivery_unavailable'
    NO_CONTEXT = 'delivery_context_unavailable'
    SECURITY_KEY = 'security_key_required'
    INVALID_CODE = 'invalid_code'
    PRIMARY = 'primary_authentication_required'
    LIMITED = 'provider_rate_limited'
    TRANSPORT = 'transport_unavailable'
    UNKNOWN = 'unclassified_failure'

@dataclass(frozen=True)
class Decision:
    state: str
    reason: str
    effect_attempted: bool

class AuthGate:
    def __init__(self, persist: Callable[[dict], None], saved=None, *, automatic_recovery=False,
                 persist_recovery=None, recovery_saved=None):
        if type(automatic_recovery) is not bool:
            raise ValueError('invalid_automatic_recovery_policy')
        self.automatic_recovery = automatic_recovery
        if automatic_recovery and not callable(persist_recovery):
            raise ValueError('recovery_persistence_required')
        if recovery_saved is not None and (
                type(recovery_saved) is not dict
                or set(recovery_saved) != {'schema_version', 'primary_attempted'}
                or type(recovery_saved['schema_version']) is not int
                or recovery_saved['schema_version'] != 1
                or type(recovery_saved['primary_attempted']) is not bool):
            raise ValueError('invalid_recovery_metadata')
        self.persist_recovery = persist_recovery
        self.primary_attempted = recovery_saved['primary_attempted'] if recovery_saved is not None else False
        self.persist = persist
        self.state = State.PROBE if saved is None else State(saved['state'])
        if saved is not None and (set(saved) != {'schema_version','state'} or saved['schema_version'] != 1):
            raise ValueError('invalid_auth_gate_metadata')
        self.busy = False
        self._lock = Lock()

    def record(self, state):
        # Persist before effects can be attempted again after a restart.
        self.persist({'schema_version':1,'state':state.value})
        self.state = state

    def result(self, reason, attempted=False):
        return Decision(self.state.value, reason, attempted)

    def open_screen(self):
        return self.result('display_only')

    def snapshot_state(self):
        """Observe a stable gate state, or report contention without waiting."""
        if not self._lock.acquire(blocking=False):
            return self.result('operation_in_progress')
        try:
            return self.result('state_observed')
        finally:
            self._lock.release()

    def cached_session(self, validate_cached_token):
        # The effect owns the nonblocking lock and authoritative state recheck.
        # An unlocked busy/state precheck could mistake transient USER for expiry.
        # Caller must validate ONLY the saved token, with no login fallback.
        return self._effect(validate_cached_token, background=True)

    def recover_silently(self, authenticate_without_delivery):
        """One persisted primary-login attempt; challenges never authorize delivery."""
        if not self._lock.acquire(blocking=False):
            return self.result('operation_in_progress')
        self.busy = True
        try:
            if (not self.automatic_recovery or self.primary_attempted
                    or self.state not in (State.USER, State.PRIMARY)):
                return self.result('automatic_recovery_not_permitted')
            # A restart or unknown response must not repeat a primary login.
            self.persist_recovery({'schema_version': 1, 'primary_attempted': True})
            self.primary_attempted = True
            self.record(State.UNCERTAIN)
            try:
                outcome = Outcome(authenticate_without_delivery())
            except Exception as exc:
                diagnostic_exception('silent_session_recovery', exc)
                outcome = Outcome.UNKNOWN
            state = (State.VALID if outcome == Outcome.VALID else
                     State.UNCERTAIN if outcome in (Outcome.TRANSPORT, Outcome.UNKNOWN) else
                     State.PRIMARY)
            self.record(state)
            diagnostic('silent_session_recovery', outcome.value)
            return self.result(outcome.value, True)
        finally:
            self.busy = False
            self._lock.release()

    def confirm_account_ready(self):
        """Close a recovered incident only after the caller verifies full setup.

        Token acceptance alone is insufficient: the device service can still
        reject it. Neither loading persisted state nor opening a repair calls
        this method. The marker format stays rollback-compatible.
        """
        if not self._lock.acquire(blocking=False):
            return self.result('operation_in_progress')
        try:
            if self.state != State.VALID:
                return self.result('authenticated_setup_required')
            if not self.automatic_recovery or not self.primary_attempted:
                return self.result('account_ready')
            self.persist_recovery({'schema_version': 1, 'primary_attempted': False})
            self.primary_attempted = False
            return self.result('recovered_incident_closed')
        finally:
            self._lock.release()

    def submit(self, action, callback, *, explicit_submission=False):
        if not explicit_submission: return self.result('explicit_submission_required')
        if self.busy: return self.result('operation_in_progress')
        if action not in ('prepare_session','request_challenge','verify_code'):
            return self.result('unsupported_action')
        if self.state == State.UNCERTAIN:
            return self.result('delivery_unknown')
        if action == 'prepare_session' and self.state in (State.READY, State.CODE):
            return self.result('challenge_already_prepared')
        if action == 'verify_code' and self.state != State.CODE:
            return self.result('no_active_challenge')
        if action == 'request_challenge' and self.state != State.READY:
            return self.result('no_active_challenge')
        # An explicit submission grants one call, never an automatic retry.
        return self._effect(callback, background=False, action=action)

    def _effect(self, callback, *, background, action=None):
        if not self._lock.acquire(blocking=False): return self.result('operation_in_progress')
        self.busy = True
        stage = 'persist_before'
        try:
            # Recheck after acquiring the lock: another completed operation may
            # have expired the session between the caller's check and this point.
            if background and self.state not in (State.PROBE, State.VALID):
                return self.result('waiting_for_user')
            if not background and self.state == State.UNCERTAIN:
                return self.result('delivery_unknown')
            if action == 'prepare_session' and self.state in (State.READY, State.CODE):
                return self.result('challenge_already_prepared')
            if action == 'verify_code' and self.state != State.CODE:
                return self.result('no_active_challenge')
            if action == 'request_challenge' and self.state != State.READY:
                return self.result('no_active_challenge')
            prior = self.state
            self.record(State.UNCERTAIN if action in ('request_challenge', 'verify_code') else State.USER)
            stage = action if not background else 'persist_before'
            try: outcome = Outcome(callback())
            except Exception as exc:
                if not background: diagnostic_exception(action, exc)
                outcome = Outcome.UNKNOWN
            if outcome == Outcome.VALID: state = State.VALID
            elif background and self.automatic_recovery and outcome == Outcome.UNKNOWN: state = State.UNCERTAIN
            elif background and self.automatic_recovery and outcome == Outcome.CHALLENGE: state = State.PRIMARY
            elif outcome == Outcome.CHALLENGE and not background: state = State.READY
            elif outcome == Outcome.SENT and not background: state = State.CODE
            elif outcome == Outcome.INVALID_CODE and prior == State.CODE: state = State.CODE
            elif outcome == Outcome.PRIMARY: state = State.PRIMARY
            elif outcome == Outcome.LIMITED: state = State.LIMITED
            elif outcome == Outcome.TRANSPORT and background and prior in (State.PROBE, State.VALID): state = prior
            elif action in ('request_challenge', 'verify_code') and outcome in (Outcome.TRANSPORT, Outcome.UNKNOWN): state = State.UNCERTAIN
            else: state = State.USER
            stage = 'persist_after'
            # A confirmed expiry of a previously valid session starts a new
            # incident. Restarts, challenges and ambiguous failures never do.
            if (background and self.automatic_recovery and prior == State.VALID
                    and outcome == Outcome.EXPIRED):
                self.persist_recovery({'schema_version': 1, 'primary_attempted': False})
                self.primary_attempted = False
            self.record(state)
            if not background: diagnostic(action, outcome.value)
            return self.result(outcome.value, True)
        except Exception as exc:
            if not background: diagnostic_exception(stage, exc)
            raise
        finally:
            self.busy = False
            self._lock.release()
