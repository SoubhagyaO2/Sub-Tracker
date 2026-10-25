-- 0002: two more truthful reasons a reminder can end up "skipped" instead of "sent".
--   delivery_window_missed : the reminder was still pending when its renewal date passed (the process was offline or
--                            delivery kept failing), so it is NOT delivered late and NOT pretended to be sent.
--   invalid_time_zone      : the owner's stored time zone is unusable, so the reminder instant cannot be computed.
-- Only the CHECK is widened; no rows change, so this is safe on a database that already holds reminders.
ALTER TABLE reminders DROP CONSTRAINT reminders_skip_reason_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_skip_reason_check CHECK (skip_reason IN (
  'smtp_not_configured', 'email_not_verified', 'email_disabled', 'subscription_inactive',
  'delivery_window_missed', 'invalid_time_zone'));

-- Tray / delivery-log queries: a user's reminders by channel and status, newest first.
CREATE INDEX reminders_user_channel_status_idx ON reminders (user_id, channel, status, remind_at DESC);
