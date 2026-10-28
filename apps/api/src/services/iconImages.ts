import { randomBytes } from 'node:crypto';
import type { DateOnly } from '@subcycle/shared';
import { withTransaction, type Pool } from '../db/pool.js';
import { validation } from '../errors.js';
import { findOwned, toSubscriptionDto } from './subscriptions.js';
import { readImageInfo, type ImageType } from './imageInfo.js';

/** Largest stored picture. The web app shrinks pictures to 128 x 128 before sending, so real uploads are a few KB. */
export const MAX_ICON_IMAGE_BYTES = 40 * 1024;
export const MAX_ICON_IMAGE_PIXELS = 1024;
export const ICON_IMAGE_TYPES: readonly ImageType[] = ['image/png', 'image/jpeg', 'image/webp'];

const bad = (message: string) => validation([{ path: 'image', message }]);

/** The bytes must really be a PNG / JPEG / WebP of the declared type and a sane size: the file's own header decides, not the label. */
export function checkIconImage(buffer: unknown, declaredType: string | undefined): { buffer: Buffer; type: ImageType } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw bad('Choose a PNG, JPEG or WebP image.');
  if (buffer.length > MAX_ICON_IMAGE_BYTES) throw bad(`The image is too large (the limit is ${MAX_ICON_IMAGE_BYTES / 1024} KB after shrinking).`);
  const info = readImageInfo(buffer);
  if (!info || info.type !== declaredType) throw bad('That file is not a valid PNG, JPEG or WebP image.');
  if (info.width < 1 || info.height < 1 || info.width > MAX_ICON_IMAGE_PIXELS || info.height > MAX_ICON_IMAGE_PIXELS) {
    throw bad(`The image must be at most ${MAX_ICON_IMAGE_PIXELS} x ${MAX_ICON_IMAGE_PIXELS} pixels.`);
  }
  return { buffer, type: info.type };
}

export async function setIconImage(pool: Pool, userId: string, id: string, upload: { buffer: Buffer; type: ImageType }, today: DateOnly) {
  return withTransaction(pool, async (tx) => {
    await findOwned(tx, userId, id, true); // 404 for anything that is not the caller's own; locks the row
    const version = randomBytes(8).toString('hex');
    await tx.query(
      `INSERT INTO subscription_icon_images (subscription_id, user_id, content_type, data, version) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (subscription_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, version = EXCLUDED.version, created_at = now()`,
      [id, userId, upload.type, upload.buffer, version],
    );
    const { rows } = await tx.query('UPDATE subscriptions SET icon_image_version = $3 WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId, version]);
    return toSubscriptionDto(rows[0], today);
  });
}

export async function clearIconImage(pool: Pool, userId: string, id: string, today: DateOnly) {
  return withTransaction(pool, async (tx) => {
    await findOwned(tx, userId, id, true);
    await tx.query('DELETE FROM subscription_icon_images WHERE subscription_id = $1 AND user_id = $2', [id, userId]);
    const { rows } = await tx.query('UPDATE subscriptions SET icon_image_version = NULL WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]);
    return toSubscriptionDto(rows[0], today);
  });
}

export async function getIconImage(pool: Pool, userId: string, id: string): Promise<{ data: Buffer; type: ImageType } | null> {
  const { rows } = await pool.query<{ data: Buffer; content_type: ImageType }>(
    'SELECT data, content_type FROM subscription_icon_images WHERE subscription_id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0] ? { data: rows[0].data, type: rows[0].content_type } : null;
}
