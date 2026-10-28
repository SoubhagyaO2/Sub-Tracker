import { runAxe } from '../support/a11y';
import { expect, test, ymd } from '../support/fixtures';

test.describe('quick start: suggestions and pasted links', () => {
  test('type-ahead by keyboard fills the details, never the price or date; the saved subscription carries them', async ({ page, signUp, api }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    const name = page.getByRole('combobox', { name: /Service name/ });
    await name.fill('spot');
    await expect(page.getByRole('listbox', { name: 'Suggested services' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: /Spotify/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(name).toHaveValue('Spotify');
    await expect(page).toHaveURL(/\/subscriptions\/new$/); // Enter picked the suggestion; it did not submit the form
    await expect(page.getByLabel('Category')).toHaveValue('music');
    await expect(page.getByLabel('Website (optional)')).toHaveValue('https://www.spotify.com');
    await expect(page.getByLabel(/Price per billing period/)).toHaveValue('');
    await expect(page.getByLabel(/Next billing date/)).toHaveValue('');

    await page.getByLabel(/Price per billing period/).fill('119');
    await page.getByLabel(/Next billing date/).fill(ymd(9));
    await page.getByRole('button', { name: 'Add subscription' }).click();
    await expect(page.getByRole('heading', { name: 'Spotify', level: 1 })).toBeVisible();
    const saved = (await api.get('/api/subscriptions')).body.data[0];
    expect(saved).toMatchObject({ name: 'Spotify', category: 'music', websiteUrl: 'https://www.spotify.com', icon: { kind: 'glyph', value: 'spotify' }, amountMinor: 11900 });
  });

  test('a pasted link to a well-known service is recognised without any request to the server', async ({ page, signUp }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    const lookups: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/link-preview')) lookups.push(r.url());
    });
    await page.getByLabel(/Paste a website link/).fill('https://www.netflix.com/browse?token=secret');
    await page.getByLabel(/Paste a website link/).press('Enter');
    await expect(page.getByRole('combobox', { name: /Service name/ })).toHaveValue('Netflix');
    await expect(page.getByLabel('Category')).toHaveValue('video');
    await expect(page.getByText(/Recognised Netflix/)).toBeVisible();
    await expect(page).toHaveURL(/\/subscriptions\/new$/);
    expect(lookups).toEqual([]);
  });

  test('an unknown site goes through the real server lookup and always ends in a usable, honest suggestion', async ({ page, signUp }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    const response = page.waitForResponse((r) => r.url().includes('/api/link-preview'));
    await page.getByLabel(/Paste a website link/).fill('no-such-site-subcycle-e2e.com');
    await page.getByRole('button', { name: 'Fill from link' }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: /Filled in/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Service name/ })).not.toHaveValue('');
    await expect(page.getByLabel('Website (optional)')).toHaveValue('https://no-such-site-subcycle-e2e.com');
    await expect(page.getByLabel('Category')).toHaveValue('other'); // nothing is guessed
    await expect(page.getByLabel(/Price per billing period/)).toHaveValue('');
  });

  test.describe('addresses the server must never fetch', () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', '127.0.0.1:3101/api/health', 'https://localhost', 'file:///etc/passwd', 'https://intranet.corp']) {
      test(`refuses ${target} with one fixed message`, async ({ page, signUp }) => {
        await signUp();
        await page.goto('/subscriptions/new');
        await page.getByLabel(/Paste a website link/).fill(target);
        await page.getByRole('button', { name: 'Fill from link' }).click();
        await expect(page.getByText('Enter the web address of a public website, such as https://example.com.')).toBeVisible();
        await expect(page.getByRole('combobox', { name: /Service name/ })).toHaveValue('');
        await expect(page.getByLabel('Website (optional)')).toHaveValue('');
      });
    }
  });

  test('the suggestion list fits the screen and is accessible in both themes at 320px', async ({ page, signUp, api }) => {
    await signUp();
    await page.setViewportSize({ width: 320, height: 700 });
    const problems: string[] = [];
    for (const theme of ['dark', 'light'] as const) {
      await api.patch('/api/preferences', { theme });
      await page.goto('/subscriptions/new');
      await page.getByRole('combobox', { name: /Service name/ }).fill('a');
      const list = page.getByRole('listbox', { name: 'Suggested services' });
      await expect(list).toBeVisible();
      const box = (await list.boundingBox())!;
      if (box.x < 0 || box.x + box.width > 320) problems.push(`${theme}: list leaves the viewport (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
      await page.keyboard.press('ArrowDown');
      for (const v of await runAxe(page)) problems.push(`${theme}: axe ${v.id}: ${v.help} -> ${v.targets.join(' | ')}`);
    }
    expect(problems).toEqual([]);
  });
});

test.describe('brand logos', () => {
  test('a picked service shows its real logo on the detail page, the list and the dashboard, in both themes', async ({ page, signUp, api }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    await page.getByRole('combobox', { name: /Service name/ }).fill('netf');
    await page.getByRole('option', { name: /Netflix/ }).click();
    await expect(page.getByLabel('Icon (optional)')).toHaveValue('netflix');
    await expect(page.locator('[data-logo="netflix"]').first()).toBeVisible(); // preview next to the field
    await page.getByLabel(/Price per billing period/).fill('149');
    await page.getByLabel(/Next billing date/).fill(ymd(4));
    await page.getByRole('button', { name: 'Add subscription' }).click();
    await expect(page.getByRole('heading', { name: 'Netflix', level: 1 })).toBeVisible();
    // a service without a bundled logo gets a letter tile, not a made-up logo
    await api.post('/api/subscriptions', { name: 'Disney+', amountMinor: 29900, billingFrequency: 'monthly', category: 'video', nextBillingDate: ymd(6), icon: null });

    for (const theme of ['dark', 'light'] as const) {
      await api.patch('/api/preferences', { theme });
      for (const path of ['/subscriptions', '/']) {
        await page.goto(path);
        const logo = page.locator('[data-logo="netflix"]').first();
        await expect(logo).toBeVisible();
        const box = (await logo.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(36);
        const svg = logo.locator('svg path');
        await expect(svg).toHaveAttribute('d', /^[Mm]/);
        expect((await svg.boundingBox())!.width).toBeGreaterThan(10); // actually painted
        const keys = await page.locator('[data-logo]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-logo')))]);
        expect(keys).toEqual(['netflix']); // Disney+ has no bundled logo, so it gets a letter tile
      }
    }
    // the logo is bundled: the browser never asked another host for an image
    const foreign: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'image' && !r.url().startsWith('data:') && new URL(r.url()).origin !== new URL(page.url()).origin) foreign.push(r.url());
    });
    await page.goto('/subscriptions');
    await expect(page.locator('[data-logo="netflix"]').first()).toBeVisible();
    expect(foreign).toEqual([]);
  });
});
