-- Password reset (forgot-password) tokens.
-- Only the SHA-256 of the token is stored; the token itself exists only in the emailed (or operator-printed) link.
-- A token is single-use (`used_at`), expires (`expires_at`) and is deleted with its user.
CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prt_user_idx ON password_reset_tokens (user_id);
