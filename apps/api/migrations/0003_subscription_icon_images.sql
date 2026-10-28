-- 0003: an optional picture a user can attach to one of their own subscriptions (instead of a built-in logo or emoji).
-- Small by construction: at most 40 KB, PNG / JPEG / WebP only (the type is checked against the file's own header by the API).
-- The bytes live in their own table so lists and counts never read them; `subscriptions.icon_image_version` is a short random token,
-- set only while a picture exists, used as the cache-busting part of the picture's URL.
-- Deleting the subscription (or the user) deletes the picture with it (composite foreign key, as for payments and reminders).
CREATE TABLE subscription_icon_images (
  subscription_id uuid PRIMARY KEY,
  user_id         uuid        NOT NULL,
  content_type    text        NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  data            bytea       NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 40960),
  version         text        NOT NULL CHECK (version ~ '^[0-9a-f]{16}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE CASCADE
);

ALTER TABLE subscriptions ADD COLUMN icon_image_version text CHECK (icon_image_version ~ '^[0-9a-f]{16}$');
