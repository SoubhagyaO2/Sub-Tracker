-- 0001_init: SubCycle initial schema (see docs/DATA_MODEL.md)
-- shared trigger
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ───────────── users ─────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text        NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  password_hash     text        NOT NULL,                  -- argon2id encoded string
  display_name      text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- ───────────── user_preferences (1:1) ─────────────
CREATE TABLE user_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency                char(3)  NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  theme                   text     NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light','system')),
  timezone                text     NOT NULL DEFAULT 'Asia/Kolkata',   -- IANA; validated in app against Intl
  reminder_lead_days      smallint NOT NULL DEFAULT 3 CHECK (reminder_lead_days BETWEEN 0 AND 60),
  reminder_hour           smallint NOT NULL DEFAULT 9 CHECK (reminder_hour BETWEEN 0 AND 23),
  in_app_reminders        boolean  NOT NULL DEFAULT true,
  email_reminders_enabled boolean  NOT NULL DEFAULT false,
  trial_reminders_enabled boolean  NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ───────────── sessions ─────────────
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32), -- SHA-256 of cookie token
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,   -- sliding: last_seen + 14d
  absolute_expires_at timestamptz NOT NULL,   -- created + 30d, never extended
  user_agent     text CHECK (length(user_agent) <= 300),
  CHECK (absolute_expires_at > created_at)
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expiry_idx  ON sessions (least(idle_expires_at, absolute_expires_at));

-- ───────────── email_verification_tokens ─────────────
CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       text        NOT NULL,            -- address being verified (guards against email change)
  token_hash  bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evt_user_idx ON email_verification_tokens (user_id);

-- ───────────── subscriptions ─────────────
CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  category             text NOT NULL DEFAULT 'other' CHECK (category IN (
                         'entertainment','music','video','gaming','productivity','cloud_storage',
                         'ai_tools','news_reading','fitness_health','education','shopping',
                         'utilities','finance','other')),

  amount_minor         bigint  NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  currency             char(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  billing_frequency    text    NOT NULL CHECK (billing_frequency IN ('weekly','monthly','quarterly','yearly')),

  anchor_date          date NOT NULL,          -- original billing date; recurrence is computed from this
  next_billing_date    date NOT NULL,          -- explicit & stored; rolled forward by job / on read
  start_date           date NOT NULL,
  trial_end_date       date,

  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','trial','paused','cancelled','archived')),
  status_before_archive text CHECK (status_before_archive IN ('active','trial','paused','cancelled')),
  cancelled_on         date,                   -- user-recorded; the external cancellation date

  payment_method_label text CHECK (length(payment_method_label) <= 40),  -- label only; never card data
  website_url          text CHECK (website_url ~* '^https?://' AND length(website_url) <= 2048),
  cancellation_url     text CHECK (cancellation_url ~* '^https?://' AND length(cancellation_url) <= 2048),
  notes                text CHECK (length(notes) <= 2000),

  usage_level          text CHECK (usage_level IN ('often','sometimes','rarely')),  -- user-entered only

  reminder_lead_days   smallint CHECK (reminder_lead_days BETWEEN 0 AND 60),        -- NULL = inherit preference
  reminders_enabled    boolean NOT NULL DEFAULT true,

  icon_kind            text NOT NULL DEFAULT 'none' CHECK (icon_kind IN ('none','glyph','emoji')),
  icon_value           text CHECK (length(icon_value) <= 32),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, user_id),                        -- target for composite child FKs

  CONSTRAINT trial_requires_end_date  CHECK (status <> 'trial' OR trial_end_date IS NOT NULL),
  CONSTRAINT cancelled_requires_date  CHECK (status <> 'cancelled' OR cancelled_on IS NOT NULL),
  CONSTRAINT archive_requires_prev    CHECK ((status = 'archived') = (status_before_archive IS NOT NULL)),
  CONSTRAINT icon_value_present       CHECK ((icon_kind = 'none') = (icon_value IS NULL)),
  CONSTRAINT trial_end_after_start    CHECK (trial_end_date IS NULL OR trial_end_date >= start_date)
);
CREATE INDEX subs_user_status_next_idx ON subscriptions (user_id, status, next_billing_date);
CREATE INDEX subs_user_created_idx     ON subscriptions (user_id, created_at DESC);
CREATE INDEX subs_user_category_idx    ON subscriptions (user_id, category);
CREATE INDEX subs_user_name_idx        ON subscriptions (user_id, lower(name));
-- Rolling-forward job: only rows that need work
CREATE INDEX subs_rollforward_idx      ON subscriptions (next_billing_date) WHERE status IN ('active','trial');

-- ───────────── payments ─────────────
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  amount_minor     bigint  NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  paid_on          date    NOT NULL,
  status           text    NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','failed','refunded')),
  for_billing_date date,                         -- which renewal this covers (optional)
  note             text CHECK (length(note) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, user_id)
    REFERENCES subscriptions (id, user_id) ON DELETE CASCADE   -- child can never point at another user's subscription
);
CREATE INDEX payments_sub_paid_idx  ON payments (subscription_id, paid_on DESC, id);
CREATE INDEX payments_user_paid_idx ON payments (user_id, paid_on DESC);
CREATE UNIQUE INDEX payments_one_paid_per_period_uq
  ON payments (subscription_id, for_billing_date)
  WHERE status = 'paid' AND for_billing_date IS NOT NULL;

-- ───────────── subscription_price_history (changes only) ─────────────
CREATE TABLE subscription_price_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  old_amount_minor bigint  NOT NULL CHECK (old_amount_minor > 0),
  new_amount_minor bigint  NOT NULL CHECK (new_amount_minor > 0),
  currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_on     date    NOT NULL,
  note             text CHECK (length(note) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (old_amount_minor <> new_amount_minor),
  FOREIGN KEY (subscription_id, user_id)
    REFERENCES subscriptions (id, user_id) ON DELETE CASCADE
);
CREATE INDEX price_hist_sub_idx ON subscription_price_history (subscription_id, effective_on DESC, id);

-- ───────────── reminders ─────────────
CREATE TABLE reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('renewal','trial_end')),
  channel          text NOT NULL CHECK (channel IN ('in_app','email')),
  target_date      date     NOT NULL,            -- the renewal / trial-end date being reminded about
  lead_days        smallint NOT NULL CHECK (lead_days BETWEEN 0 AND 60),
  remind_at        timestamptz NOT NULL,         -- computed in user's zone, stored UTC
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sent','failed','skipped','superseded')),
  skip_reason      text CHECK (skip_reason IN ('smtp_not_configured','email_not_verified',
                                               'email_disabled','subscription_inactive')),
  attempts         smallint NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  last_error       text CHECK (length(last_error) <= 300),   -- sanitized; no credentials
  sent_at          timestamptz,                  -- for in_app: when it became visible
  read_at          timestamptz,                  -- in_app only: dismissed/read
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, user_id)
    REFERENCES subscriptions (id, user_id) ON DELETE CASCADE,
  -- duplicate-reminder guard (SPEC §4.7)
  CONSTRAINT reminders_unique_per_renewal
    UNIQUE (subscription_id, kind, target_date, lead_days, channel),
  CONSTRAINT skipped_has_reason CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT read_only_in_app   CHECK (read_at IS NULL OR channel = 'in_app')
);
CREATE INDEX reminders_due_idx  ON reminders (remind_at) WHERE status = 'pending';
CREATE INDEX reminders_user_idx ON reminders (user_id, remind_at DESC);


-- ───────────── updated_at triggers ─────────────
CREATE TRIGGER users_set_updated_at            BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_preferences_set_updated_at BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subscriptions_set_updated_at    BEFORE UPDATE ON subscriptions    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_set_updated_at         BEFORE UPDATE ON payments         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reminders_set_updated_at        BEFORE UPDATE ON reminders        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
