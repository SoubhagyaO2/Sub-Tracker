import zlib from 'node:zlib';
import { apiFor, expect, test, ymd } from '../support/fixtures';
import { EMAIL_DOMAIN, EMAIL_PREFIX, deleteTestUsers } from '../support/env';

/** A real, decodable PNG (a gradient), made without any image library. */
function gradientPng(width = 300, height = 200): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 255) / width;
      row[2 + x * 3] = (y * 255) / height;
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test.describe('your own picture for a subscription (optional)', () => {
  test('add a picture while creating: it is shrunk in the browser, stored, and shown everywhere; then remove it', async ({ page, signUp, api }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    await page.getByLabel(/Service name/).fill('My local gym');
    await page.getByLabel(/Price per billing period/).fill('999');
    await page.getByLabel(/Next billing date/).fill(ymd(7));
    await page.getByLabel(/Your own picture/).setInputFiles({ name: 'gym.png', mimeType: 'image/png', buffer: gradientPng() });
    await expect(page.getByText(/Picture ready/)).toBeVisible();
    await expect(page.locator('[data-picture-preview]')).toBeVisible();
    await page.getByRole('button', { name: 'Add subscription' }).click();
    await expect(page.getByRole('heading', { name: 'My local gym', level: 1 })).toBeVisible();

    // The stored picture is the SHRUNK one, served from our own origin.
    const sub = (await api.get('/api/subscriptions')).body.data[0];
    expect(sub.icon.kind).toBe('image');
    expect(sub.icon.value).toMatch(/^\/api\/subscriptions\/[0-9a-f-]+\/icon-image\?v=[0-9a-f]{16}$/);
    const served = await page.request.get(sub.icon.value);
    expect(served.status()).toBe(200);
    expect(['image/webp', 'image/png']).toContain(served.headers()['content-type']);
    expect((await served.body()).length).toBeLessThanOrEqual(40 * 1024);
    expect(served.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");

    // It really paints (decoded, 128 x 128), on the detail page, the list and the dashboard.
    for (const path of [`/subscriptions/${sub.id}`, '/subscriptions', '/']) {
      await page.goto(path);
      const img = page.locator('[data-picture] img').first();
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(128);
    }

    // Edit: remove it again.
    await page.goto(`/subscriptions/${sub.id}/edit`);
    await expect(page.locator('[data-picture-preview]')).toBeVisible();
    await page.getByRole('button', { name: 'Remove picture' }).click();
    await expect(page.getByText('Picture removed.')).toBeVisible();
    expect((await api.get(`/api/subscriptions/${sub.id}`)).body.data.icon).toBeNull();
    expect((await page.request.get(sub.icon.value)).status()).toBe(404);
  });

  test('add a picture to an existing subscription; picking a logo afterwards replaces the picture', async ({ page, signUp, addSub, api }) => {
    await signUp();
    const created = await addSub({ name: 'Netflix', amountMinor: 14900, nextBillingDate: ymd(3) });
    await page.goto(`/subscriptions/${created.id}/edit`);
    await page.getByLabel(/Your own picture/).setInputFiles({ name: 'mine.png', mimeType: 'image/png', buffer: gradientPng(64, 64) });
    await expect(page.getByText('Picture saved.')).toBeVisible();
    await expect.poll(async () => (await api.get(`/api/subscriptions/${created.id}`)).body.data.icon?.kind).toBe('image');

    await page.getByLabel('Icon (optional)').fill('netflix');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved changes to Netflix.')).toBeVisible();
    expect((await api.get(`/api/subscriptions/${created.id}`)).body.data.icon).toEqual({ kind: 'glyph', value: 'netflix' });
  });

  test('files that are not PNG, JPEG or WebP are refused in the browser, and nothing is sent', async ({ page, signUp, addSub }) => {
    await signUp();
    const created = await addSub({ name: 'Gym', amountMinor: 5000, nextBillingDate: ymd(3) });
    await page.goto(`/subscriptions/${created.id}/edit`);
    const uploads: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('icon-image')) uploads.push(r.url());
    });
    const files = [
      { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
      { name: 'x.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') },
      { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('this is not really a png') },
    ];
    for (const file of files) {
      await page.getByLabel(/Your own picture/).setInputFiles(file);
      await expect(page.getByRole('alert').filter({ hasText: /PNG, JPEG or WebP|could not be read/ })).toBeVisible();
    }
    expect(uploads).toEqual([]);
  });

  test('another user cannot read, replace or delete a picture', async ({ browser, page, signUp, addSub, api }) => {
    await signUp();
    const created = await addSub({ name: 'Private', amountMinor: 5000, nextBillingDate: ymd(3) });
    await page.goto(`/subscriptions/${created.id}/edit`);
    await page.getByLabel(/Your own picture/).setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: gradientPng(64, 64) });
    await expect(page.getByText('Picture saved.')).toBeVisible();
    const url = (await api.get(`/api/subscriptions/${created.id}`)).body.data.icon.value as string;

    const other = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.88.0.7' } });
    const email = `${EMAIL_PREFIX}pic${Date.now().toString(16)}${EMAIL_DOMAIN}`;
    try {
      const otherApi = apiFor(other.request);
      expect((await otherApi.post('/api/auth/register', { email, password: 'Tr0ub4dor&3-horse', displayName: 'Other' })).status).toBe(201);
      expect((await other.request.get(url)).status()).toBe(404);
      expect((await otherApi.del(`/api/subscriptions/${created.id}/icon-image`)).status).toBe(404);
    } finally {
      await other.close();
      await deleteTestUsers([email]);
    }
    expect((await page.request.get(url)).status()).toBe(200);
  });
});
