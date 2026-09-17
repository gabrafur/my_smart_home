const stableMs = Number(msg.policy?.home_confirmation_seconds) * 1000;
const windowMs = Number(msg.policy?.home_confirmation_window_seconds) * 1000;
msg.home_confirmation_started_at = Date.now();
msg.home_confirmation_deadline_at = Date.now() + windowMs;
msg.home_confirmation_required_ms = stableMs;
msg.home_confirmation_recheck_ms =
    Number(msg.policy?.home_confirmation_recheck_seconds) * 1000;
msg.delay = msg._location_test === true ? 1 : stableMs;
return msg;
