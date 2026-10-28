import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readImageInfo } from '../src/services/imageInfo.js';
import { MAX_ICON_IMAGE_BYTES, MAX_ICON_IMAGE_PIXELS } from '../src/services/iconImages.js';
import { CSRF, client, createCtx, createSub, loginCookie, registerUser, resetDb, userIdOf } from './helpers.js';

// ───────────── tiny valid headers for each format (only the part the header reader looks at, padded to a plausible size) ─────────────
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
/** A real, decodable PNG of a flat colour (so the bytes are genuinely an image, not just a header). */
function png(width: number, height: number, extra = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const { deflateSync } = require_zlib();
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(Math.min(width, 64), 0x80)]);
  const idat = deflateSync(Buffer.concat(Array.from({ length: Math.min(height, 64) }, () => row)));
  const pad = extra ? chunk('tEXt', Buffer.alloc(extra, 0x41)) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), pad, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
import zlib from 'node:zlib';
const require_zlib = () => zlib;

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(17, 0); // length
  sof[2] = 8; // precision
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), Buffer.from([0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])]);
}
function webpLossy(width: number, height: number): Buffer {
  const d = Buffer.alloc(10);
  d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a;
  d.writeUInt16LE(width, 6);
  d.writeUInt16LE(height, 8);
  const size = Buffer.alloc(4); size.writeUInt32LE(4 + 8 + d.length);
  const csize = Buffer.alloc(4); csize.writeUInt32LE(d.length);
  return Buffer.concat([Buffer.from('RIFF'), size, Buffer.from('WEBP'), Buffer.from('VP8 '), csize, d]);
}
function webpLossless(width: number, height: number): Buffer {
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  const w = width - 1, h = height - 1;
  d[1] = w & 0xff; d[2] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6); d[3] = (h >> 2) & 0xff; d[4] = (h >> 10) & 0x0f;
  const size = Buffer.alloc(4); size.writeUInt32LE(4 + 8 + 10);
  const csize = Buffer.alloc(4); csize.writeUInt32LE(10);
  return Buffer.concat([Buffer.from('RIFF'), size, Buffer.from('WEBP'), Buffer.from('VP8L'), csize, d, Buffer.alloc(10)]);
}
function webpExtended(width: number, height: number): Buffer {
  const d = Buffer.alloc(10);
  d.writeUIntLE(width - 1, 4, 3);
  d.writeUIntLE(height - 1, 7, 3);
  const size = Buffer.alloc(4); size.writeUInt32LE(4 + 8 + 10);
  const csize = Buffer.alloc(4); csize.writeUInt32LE(10);
  return Buffer.concat([Buffer.from('RIFF'), size, Buffer.from('WEBP'), Buffer.from('VP8X'), csize, d]);
}

describe('readImageInfo', () => {
  it.each([
    ['png', png(128, 96), 'image/png', 128, 96],
    ['jpeg', jpeg(200, 150), 'image/jpeg', 200, 150],
    ['webp (lossy)', webpLossy(128, 128), 'image/webp', 128, 128],
    ['webp (lossless)', webpLossless(300, 77), 'image/webp', 300, 77],
    ['webp (extended)', webpExtended(640, 480), 'image/webp', 640, 480],
  ])('reads %s', (_n, buf, type, width, height) => {
    expect(readImageInfo(buf)).toEqual({ type, width, height });
  });
  it.each([
    ['empty', Buffer.alloc(0)], ['text', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')], ['html', Buffer.from('<html><body>hi</body></html>')],
    ['gif', Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00', 'latin1')], ['truncated png', png(10, 10).subarray(0, 20)], ['png signature only', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['riff but not webp', Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt '), Buffer.alloc(20)])], ['jpeg without a frame', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['random bytes', Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256))],
  ])('does not accept %s', (_n, buf) => {
    expect(readImageInfo(buf)).toBeNull();
  });
});

describe('subscription pictures', () => {
  const ctx = createCtx();
  const { app, pool } = ctx;
  let cookie: string;
  let userId: string;
  let subId: string;
  let api: ReturnType<typeof client>;
  beforeEach(async () => {
    await resetDb(pool);
    const reg = await registerUser(app);
    cookie = reg.cookie;
    userId = userIdOf(reg.res);
    api = client(app, cookie);
    subId = (await createSub(app, cookie, { name: 'My gym' })).id;
  });
  afterAll(() => pool.end());

  const put = (id: string, body: Buffer, type = 'image/png', c = cookie) => request(app).put(`/api/subscriptions/${id}/icon-image`).set(CSRF).set('Cookie', c).set('Content-Type', type).send(body);
  const fetchImage = (id: string, c = cookie) => request(app).get(`/api/subscriptions/${id}/icon-image`).set('Cookie', c).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

  it('attaches a picture: the subscription now reports an image icon with a same-origin URL, and the bytes come back unchanged', async () => {
    const image = png(128, 128);
    const res = await put(subId, image);
    expect(res.status).toBe(200);
    expect(res.body.data.icon).toMatchObject({ kind: 'image' });
    expect(res.body.data.icon.value).toMatch(new RegExp(`^/api/subscriptions/${subId}/icon-image\\?v=[0-9a-f]{16}$`));
    const got = await fetchImage(subId);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(got.body as Buffer, image)).toBe(0);
    // hardening headers on the served bytes
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    // it shows up everywhere the icon does: get, list and the calendar
    expect((await api.get(`/api/subscriptions/${subId}`)).body.data.icon.kind).toBe('image');
    expect((await api.get('/api/subscriptions')).body.data[0].icon.kind).toBe('image');
  });

  it.each([
    ['image/png', () => png(64, 64)], ['image/jpeg', () => jpeg(64, 64)], ['image/webp', () => webpLossy(64, 64)], ['image/webp', () => webpLossless(64, 64)],
  ])('accepts a valid %s', async (type, make) => {
    expect((await put(subId, make(), type)).status).toBe(200);
    expect((await fetchImage(subId)).headers['content-type']).toBe(type);
  });

  it('replacing the picture changes its URL (so caches cannot show the old one) and keeps exactly one row', async () => {
    const first = (await put(subId, png(32, 32))).body.data.icon.value as string;
    const second = (await put(subId, png(64, 64))).body.data.icon.value as string;
    expect(second).not.toBe(first);
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images WHERE subscription_id = $1', [subId])).rows[0].n).toBe(1);
  });

  it('does not list pictures with the pictures: lists carry only the short URL', async () => {
    await put(subId, png(128, 128, 20_000));
    const list = JSON.stringify((await api.get('/api/subscriptions')).body);
    expect(list.length).toBeLessThan(3000);
  });

  it.each([
    ['a label that lies (SVG bytes sent as image/png)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png'],
    ['a PNG labelled as JPEG', png(10, 10), 'image/jpeg'],
    ['a JPEG labelled as PNG', jpeg(10, 10), 'image/png'],
    ['garbage', Buffer.from('not an image at all'), 'image/webp'],
    ['a truncated PNG', png(10, 10).subarray(0, 24), 'image/png'],
    ['an image with absurd dimensions', png(MAX_ICON_IMAGE_PIXELS + 1, 10), 'image/png'],
    ['a zero-size JPEG', jpeg(0, 0), 'image/jpeg'],
  ])('refuses %s with a field error and stores nothing', async (_label, body, type) => {
    const res = await put(subId, body, type);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('image');
    expect((await api.get(`/api/subscriptions/${subId}`)).body.data.icon).toBeNull();
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images')).rows[0].n).toBe(0);
  });

  it.each(['image/svg+xml', 'image/gif', 'text/html', 'application/json', 'application/octet-stream'])('refuses the content type %s', async (type) => {
    const res = await request(app).put(`/api/subscriptions/${subId}/icon-image`).set(CSRF).set('Cookie', cookie).set('Content-Type', type).send(png(10, 10));
    expect(res.status).toBe(422);
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images')).rows[0].n).toBe(0);
  });

  it('refuses a picture over the size limit (413) and an empty body', async () => {
    const big = await put(subId, png(100, 100, MAX_ICON_IMAGE_BYTES + 2000));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const justOver = await put(subId, png(100, 100, MAX_ICON_IMAGE_BYTES)); // a little over 40 KB: within the transport limit, over the stored limit
    expect(justOver.status).toBe(422);
    expect(justOver.body.error.details[0].message).toMatch(/too large/);
    expect((await put(subId, Buffer.alloc(0))).status).toBe(422);
  });

  it('needs a session and the CSRF header', async () => {
    expect((await put(subId, png(10, 10), 'image/png', '')).status).toBe(401);
    const noCsrf = await request(app).put(`/api/subscriptions/${subId}/icon-image`).set('Cookie', cookie).set('Content-Type', 'image/png').send(png(10, 10));
    expect(noCsrf.status).toBe(403);
    expect((await request(app).get(`/api/subscriptions/${subId}/icon-image`)).status).toBe(401);
    expect((await request(app).delete(`/api/subscriptions/${subId}/icon-image`).set(CSRF)).status).toBe(401);
  });

  it('is private to its owner: another user cannot upload to, read or delete it, and gets the same 404 as for a missing subscription', async () => {
    await put(subId, png(32, 32));
    const other = await registerUser(app);
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const id of [subId, missing, 'not-a-uuid']) {
      expect((await put(id, png(10, 10), 'image/png', other.cookie)).status, `PUT ${id}`).toBe(404);
      expect((await fetchImage(id, other.cookie)).status, `GET ${id}`).toBe(404);
      expect((await client(app, other.cookie).del(`/api/subscriptions/${id}/icon-image`)).status, `DELETE ${id}`).toBe(404);
    }
    expect((await fetchImage(subId)).status).toBe(200); // the owner's picture is untouched
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images')).rows[0].n).toBe(1);
  });

  it('removing the picture returns to the built-in logo or emoji underneath; it is idempotent', async () => {
    await api.patch(`/api/subscriptions/${subId}`, { icon: { kind: 'glyph', value: 'netflix' } });
    await put(subId, png(32, 32));
    expect((await api.get(`/api/subscriptions/${subId}`)).body.data.icon.kind).toBe('image');
    const res = await api.del(`/api/subscriptions/${subId}/icon-image`);
    expect(res.status).toBe(200);
    expect(res.body.data.icon).toEqual({ kind: 'glyph', value: 'netflix' });
    expect((await fetchImage(subId)).status).toBe(404);
    expect((await api.del(`/api/subscriptions/${subId}/icon-image`)).status).toBe(200);
  });

  it('choosing a logo, an emoji or no icon replaces a picture the user had', async () => {
    await put(subId, png(32, 32));
    expect((await api.patch(`/api/subscriptions/${subId}`, { icon: { kind: 'emoji', value: '🏋️' } })).body.data.icon).toEqual({ kind: 'emoji', value: '🏋️' });
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images')).rows[0].n).toBe(0);
    await put(subId, png(32, 32));
    expect((await api.patch(`/api/subscriptions/${subId}`, { icon: null })).body.data.icon).toBeNull();
    await put(subId, png(32, 32));
    expect((await api.patch(`/api/subscriptions/${subId}`, { name: 'Renamed' })).body.data.icon.kind).toBe('image'); // unrelated edits keep it
  });

  it('the API never accepts an "image" icon through the ordinary icon field', async () => {
    const res = await api.patch(`/api/subscriptions/${subId}`, { icon: { kind: 'image', value: '/api/subscriptions/x/icon-image?v=0123456789abcdef' } });
    expect(res.status).toBe(422);
    expect((await api.post('/api/subscriptions', { name: 'X', amountMinor: 100, billingFrequency: 'monthly', nextBillingDate: '2030-02-01', icon: { kind: 'image', value: 'http://evil.example/x.png' } })).status).toBe(422);
  });

  it('shows in the calendar feed too', async () => {
    await put(subId, png(32, 32));
    const cal = await api.get('/api/calendar/renewals');
    expect(cal.body.data.find((o: { subscriptionId: string }) => o.subscriptionId === subId).icon.kind).toBe('image');
  });

  it('is deleted with the subscription and with the account (cascade), and nothing else is touched', async () => {
    const other = await registerUser(app);
    const otherSub = (await createSub(app, other.cookie, { name: 'Theirs' })).id;
    await put(otherSub, png(32, 32), 'image/png', other.cookie);
    await put(subId, png(32, 32));
    expect((await api.del(`/api/subscriptions/${subId}`)).status).toBe(204);
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images WHERE user_id = $1', [userId])).rows[0].n).toBe(0);
    const again = (await createSub(app, cookie, { name: 'Again' })).id;
    await put(again, png(32, 32));
    expect((await api.del('/api/account', { password: 'Tr0ub4dor&3-horse', confirmEmail: (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email })).status).toBe(204);
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images WHERE user_id = $1', [userId])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM subscription_icon_images')).rows[0].n).toBe(1); // the other user's picture
    expect((await fetchImage(otherSub, await loginCookie(app, (await pool.query('SELECT email FROM users WHERE id <> $1', [userId])).rows[0].email))).status).toBe(200);
  });

  it('the database itself refuses an oversized or mis-typed picture', async () => {
    await expect(pool.query("INSERT INTO subscription_icon_images (subscription_id, user_id, content_type, data, version) VALUES ($1, $2, 'image/png', $3, '0123456789abcdef')", [subId, userId, Buffer.alloc(41 * 1024)])).rejects.toThrow();
    await expect(pool.query("INSERT INTO subscription_icon_images (subscription_id, user_id, content_type, data, version) VALUES ($1, $2, 'image/svg+xml', $3, '0123456789abcdef')", [subId, userId, Buffer.alloc(10)])).rejects.toThrow();
    await expect(pool.query("INSERT INTO subscription_icon_images (subscription_id, user_id, content_type, data, version) VALUES ($1, $2, 'image/png', $3, 'x')", [subId, userId, Buffer.alloc(10)])).rejects.toThrow();
  });
});
