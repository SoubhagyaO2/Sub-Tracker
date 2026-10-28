import type net from 'node:net';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORIES, SERVICE_CATALOG, searchServices, serviceForHostname } from '@subcycle/shared';
import {
  LinkRejected, MAX_BODY_BYTES, createSafeLookup, extractName, httpsTransport, isPublicAddress, nameFromHost, parsePublicUrl, previewLink,
  type PageResponse, type Transport,
} from '../src/services/linkPreview.js';
import { captureLogs, client, createCtx, registerUser, resetDb } from './helpers.js';

const page = (over: Partial<PageResponse> = {}): PageResponse => ({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html><head><title>Acme Cloud - Home</title></head>', ...over });

describe('parsePublicUrl: only plain public https web addresses', () => {
  it.each([
    ['netflix.com', 'https://netflix.com/'],
    ['https://www.example.com/path?x=1#frag', 'https://www.example.com/path?x=1'],
    ['http://example.com', 'https://example.com/'], // never fetched in clear text
    ['  HTTPS://EXAMPLE.COM.  ', 'https://example.com/'],
    ['https://example.com\n', 'https://example.com/'], // surrounding whitespace is trimmed
    ['https://example.com:443/', 'https://example.com/'],
    ['https://bücher.example.org', 'https://xn--bcher-kva.example.org/'],
  ])('accepts %j', (input, expected) => {
    expect(parsePublicUrl(input).href).toBe(expected);
  });

  it.each([
    '', '   ', 'localhost', 'http://localhost:3001', 'https://localhost', '127.0.0.1', 'https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://0.0.0.0', '2130706433', 'https://0x7f.0.0.1', 'https://0177.0.0.1', 'https://127.1', 'https://10.0.0.1', 'https://192.168.1.1', 'https://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal', 'https://printer.local', 'https://nas.lan', 'https://router.home.arpa', 'https://intranet', 'https://corp',
    'ftp://example.com', 'file:///etc/passwd', 'gopher://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'ws://example.com',
    'https://user:pw@example.com', 'https://netflix.com@evil.example.org', 'https://example.com:8443', 'https://example.com:22', 'https://example.com:80',
    'https://exa mple.com', 'https://exam\u0000ple.com', 'https://-bad.com', 'https://bad_host.com', 'https://a..com', 'https://.com',
    `https://${'a'.repeat(64)}.com`, `https://${'a.'.repeat(130)}com`, 'https://example.invalid', 'https://x.onion', 'https://thing.test', 'not a url at all',
  ])('rejects %j', (input) => {
    expect(() => parsePublicUrl(input), String(input)).toThrow(LinkRejected);
  });
});

describe('isPublicAddress: only globally routable unicast addresses', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '11.0.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1'])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', 'fe80::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '2001::1', '100::1',
    'not an ip', '', '8.8.8', '8.8.8.8.8', '999.1.1.1',
  ])('%s is refused', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('createSafeLookup validates every resolved address, at connection time', () => {
  const call = (resolver: Parameters<typeof createSafeLookup>[0], all: boolean) =>
    new Promise<{ err: unknown; result: unknown }>((done) => {
      (createSafeLookup(resolver) as unknown as (h: string, o: object, cb: (e: unknown, a?: unknown, f?: number) => void) => void)('example.com', { all }, (err, a, f) => done({ err, result: all ? a : { address: a, family: f } }));
    });
  it('hands back public addresses (single and all)', async () => {
    const r = async () => [{ address: '93.184.216.34', family: 4 }];
    expect((await call(r, false)).result).toEqual({ address: '93.184.216.34', family: 4 });
    expect((await call(r, true)).result).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
  it.each([
    ['one private address', [{ address: '10.0.0.5', family: 4 }]],
    ['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['link-local metadata address', [{ address: '169.254.169.254', family: 4 }]],
    ['a mix of public and private (rebinding trick)', [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]],
    ['IPv6 loopback', [{ address: '::1', family: 6 }]],
    ['IPv4-mapped IPv6 private', [{ address: '::ffff:10.0.0.1', family: 6 }]],
    ['nothing', []],
  ])('refuses %s', async (_label, addrs) => {
    const { err } = await call(async () => addrs, true);
    expect(err).toBeInstanceOf(LinkRejected);
    expect((await call(async () => addrs, false)).err).toBeInstanceOf(LinkRejected);
  });
  it('passes real resolution failures through unchanged', async () => {
    const boom = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect((await call(async () => { throw boom; }, true)).err).toBe(boom);
  });
});

describe('the real https transport cannot be pointed at a private address', () => {
  it('refuses at the socket lookup, before any connection is attempted', async () => {
    const lookup = createSafeLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(httpsTransport(new URL('https://example.com/'), lookup)).rejects.toBeInstanceOf(LinkRejected);
    await expect(previewLink('https://example.com/', { lookup })).rejects.toBeInstanceOf(LinkRejected);
  });
  it('a name that resolves to the cloud metadata address is rejected the same way', async () => {
    const lookup = createSafeLookup(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(previewLink('https://totally-legit-site.com', { lookup })).rejects.toBeInstanceOf(LinkRejected);
  });
});

describe('extractName and nameFromHost', () => {
  it.each([
    ['<title>Netflix - Watch TV Shows Online, Watch Movies Online</title>', 'Netflix'],
    ['<title>Acme | The best cloud</title>', 'Acme'],
    ['<title>  Acme\n   Cloud  </title>', 'Acme Cloud'],
    ['<meta property="og:site_name" content="Real Name"><title>Something else - Home</title>', 'Real Name'],
    ["<meta content='Reversed Attrs' property='og:site_name'>", 'Reversed Attrs'],
    ['<meta name="application-name" content="App Name"><title>x</title>', 'App Name'],
    ['<title>Caf&eacute; &amp; Co &#39;Quotes&#39; &#x26; more</title>', 'Café & Co \'Quotes\' & more'],
    ['<title>' + 'A'.repeat(300) + '</title>', 'A'.repeat(80)],
    ['<meta property="og:title" content="Only OG Title - tagline">', 'Only OG Title'],
  ])('%j -> %j', (html, expected) => {
    expect(extractName(html)).toBe(expected);
  });
  it.each(['', '<title></title>', '<title>x</title>', '<html>no title</html>', '<title>   </title>', '<title>| only separator</title>'])('%j -> null', (html) => {
    expect(extractName(html)).toBeNull();
  });
  it('returns text only: markup in a title stays inert text and control characters are removed', () => {
    const name = extractName('<title>Evil<script>alert(1)</script>\u0007 Shop</title>')!;
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    expect(name).not.toMatch(/[\u0000-\u001f]/);
    expect(name.length).toBeLessThanOrEqual(80);
  });
  it('ignores anything past the size limit', () => {
    expect(extractName('x'.repeat(MAX_BODY_BYTES + 10) + '<title>Late Title</title>')).toBeNull();
  });
  it.each([
    ['www.some-shop.com', 'Some shop'], ['netflix.com', 'Netflix'], ['www.bbc.co.uk', 'Bbc'], ['shop.example.org', 'Example'], ['a.b.c.example.com', 'Example'],
  ])('nameFromHost(%s) -> %s', (host, expected) => {
    expect(nameFromHost(host)).toBe(expected);
  });
});

describe('previewLink with a fake transport', () => {
  const noLookup = createSafeLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  const recording = (responses: (PageResponse | Error)[]) => {
    const seen: { url: string; lookup: net.LookupFunction }[] = [];
    const transport: Transport = async (url, lookup) => {
      seen.push({ url: url.href, lookup });
      const next = responses.shift() ?? page({ status: 500, body: '' });
      if (next instanceof Error) throw next;
      return next;
    };
    return { seen, transport };
  };

  it('a known service is recognised from the address alone: no request is made', async () => {
    const { seen, transport } = recording([]);
    const r = await previewLink('https://www.netflix.com/browse', { transport, lookup: noLookup });
    expect(r).toMatchObject({ name: 'Netflix', category: 'video', websiteUrl: 'https://www.netflix.com', source: 'catalog' });
    expect(r.icon).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('an unknown site: the name comes from the page title, with no category or icon invented', async () => {
    const { seen, transport } = recording([page()]);
    const r = await previewLink('acme-cloud.com/pricing?plan=pro', { transport, lookup: noLookup });
    expect(r).toEqual({ name: 'Acme Cloud', websiteUrl: 'https://acme-cloud.com', category: null, icon: null, source: 'page' });
    expect(seen.map((s) => s.url)).toEqual(['https://acme-cloud.com/pricing?plan=pro']);
    expect(seen[0]!.lookup).toBe(noLookup); // the validating lookup is what the transport must use
  });

  it.each([
    ['a 404', page({ status: 404, body: '' })],
    ['a 500', page({ status: 500, body: '' })],
    ['a non-HTML answer', page({ contentType: 'application/json', body: '{"title":"nope"}' })],
    ['no content type', page({ contentType: undefined })],
    ['a page without a usable title', page({ body: '<html><head></head>' })],
    ['a timeout', new Error('timeout')],
    ['a refused connection', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
    ['a failed name lookup', Object.assign(new Error('nx'), { code: 'ENOTFOUND' })],
    ['a TLS error', Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' })],
  ])('%s degrades to a name derived from the address (and says so)', async (_label, response) => {
    const { transport } = recording([response]);
    const r = await previewLink('https://some-shop.com', { transport, lookup: noLookup });
    expect(r).toEqual({ name: 'Some shop', websiteUrl: 'https://some-shop.com', category: null, icon: null, source: 'address' });
  });

  it('follows up to 3 redirects, validating every hop; the final origin is returned', async () => {
    const { seen, transport } = recording([
      page({ status: 301, location: 'https://www.acme.com/', body: '' }),
      page({ status: 302, location: '/welcome', body: '' }),
      page({ body: '<title>Acme</title>' }),
    ]);
    const r = await previewLink('https://acme.com', { transport, lookup: noLookup });
    expect(r).toMatchObject({ name: 'Acme', websiteUrl: 'https://www.acme.com', source: 'page' });
    expect(seen.map((s) => s.url)).toEqual(['https://acme.com/', 'https://www.acme.com/', 'https://www.acme.com/welcome']);
  });

  it('a redirect to a known service is recognised without fetching it', async () => {
    const { seen, transport } = recording([page({ status: 301, location: 'https://www.spotify.com/in/', body: '' })]);
    const r = await previewLink('https://my-short.link', { transport, lookup: noLookup });
    expect(r).toMatchObject({ name: 'Spotify', source: 'catalog' });
    expect(seen).toHaveLength(1);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://nas.local/', 'ftp://example.com/', 'file:///etc/passwd',
    'https://user:pw@evil.example.org/', 'https://example.org:8443/',
  ])('a redirect to %s is refused, not followed', async (target) => {
    const { seen, transport } = recording([page({ status: 302, location: target, body: '' })]);
    await expect(previewLink('https://redirector.com', { transport, lookup: noLookup })).rejects.toBeInstanceOf(LinkRejected);
    expect(seen).toHaveLength(1); // only the original request was ever made
  });

  it('more than 3 redirects stops and falls back instead of looping', async () => {
    const { seen, transport } = recording(Array.from({ length: 10 }, (_, i) => page({ status: 302, location: `https://hop${i}.com/`, body: '' })));
    const r = await previewLink('https://start.com', { transport, lookup: noLookup });
    expect(r.source).toBe('address');
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it('a transport that is stopped by the validating lookup surfaces as a rejection', async () => {
    const transport: Transport = async () => {
      throw new LinkRejected('resolves to a non-public address');
    };
    await expect(previewLink('https://sneaky.com', { transport, lookup: noLookup })).rejects.toBeInstanceOf(LinkRejected);
  });
});

describe('the built-in catalogue', () => {
  it('has unique names, valid categories, https websites and single-emoji icons', () => {
    const names = SERVICE_CATALOG.map((s) => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const s of SERVICE_CATALOG) {
      expect(CATEGORIES, s.name).toContain(s.category);
      expect(new URL(s.websiteUrl).protocol, s.name).toBe('https:');
      expect(s.icon, s.name).toMatch(/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️)+$/u); // the rule the API applies to icons
      expect(s.icon.length).toBeLessThanOrEqual(32);
    }
    expect(SERVICE_CATALOG.length).toBeGreaterThanOrEqual(80);
  });
  it('contains no prices, plans or cancellation links (nothing that could be mistaken for what a user pays)', () => {
    for (const s of SERVICE_CATALOG) expect(Object.keys(s).sort().every((k) => ['name', 'category', 'websiteUrl', 'icon', 'aliases', 'hosts'].includes(k)), s.name).toBe(true);
  });
  it.each([
    ['net', 'Netflix'], ['NETFLIX', 'Netflix'], ['spot', 'Spotify'], ['prime', 'Amazon Prime Video'], ['hbo', 'Max'], ['chatgpt plus', 'ChatGPT'], ['icloud', 'iCloud+'], ['disney+ hotstar', 'JioHotstar'],
    ['yt premium', 'YouTube Premium'], ['  apple  ', 'Apple Music'],
  ])('searching %j finds %s first-ish', (q, expected) => {
    expect(searchServices(q).map((s) => s.name)).toContain(expected);
  });
  it('ranks exact and prefix matches first, and handles junk input', () => {
    expect(searchServices('netflix')[0]!.name).toBe('Netflix');
    expect(searchServices('')).toEqual([]);
    expect(searchServices('   ')).toEqual([]);
    expect(searchServices('%%%')).toEqual([]);
    expect(searchServices('zzzzzzzz')).toEqual([]);
    expect(searchServices('a', 3).length).toBeLessThanOrEqual(3);
    expect(searchServices('<script>alert(1)</script>')).toEqual([]);
  });
  it.each([
    ['netflix.com', 'Netflix'], ['www.netflix.com', 'Netflix'], ['help.netflix.com', 'Netflix'], ['NETFLIX.COM.', 'Netflix'], ['music.apple.com', 'Apple Music'], ['tv.apple.com', 'Apple TV+'],
    ['music.youtube.com', 'YouTube Music'], ['www.youtube.com', 'YouTube Premium'], ['hotstar.com', 'JioHotstar'], ['chatgpt.com', 'ChatGPT'],
  ])('host %s -> %s', (host, expected) => {
    expect(serviceForHostname(host)?.name).toBe(expected);
  });
  it.each(['evilnetflix.com', 'netflix.com.evil.example', 'notnetflix.com', 'amazon.com', 'www.amazon.com', 'github.com', 'microsoft.com', 'google.com', 'apple.com', 'example.com', ''])('host %j is never guessed', (host) => {
    expect(serviceForHostname(host)).toBeNull();
  });
});

describe('POST /api/link-preview', () => {
  const logs = captureLogs();
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url.href);
    return url.hostname === 'unreadable-site.com' ? page({ status: 503, body: '' }) : page({ body: '<title>Acme Cloud | Home</title>' });
  };
  const publicLookup = createSafeLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  const ctx = createCtx({ logger: logs.logger, linkPreview: { transport, lookup: publicLookup }, rateLimit: { linkPreviewMax: 4 } });
  let cookie: string;
  beforeEach(async () => {
    await resetDb(ctx.pool);
    calls.length = 0;
    logs.lines.length = 0;
    cookie = (await registerUser(ctx.app)).cookie;
  });
  afterAll(() => ctx.pool.end());
  const preview = (url: unknown, c: string | undefined = cookie) => client(ctx.app, c).post('/api/link-preview', url === undefined ? {} : { url });

  it('needs a session and the CSRF header', async () => {
    expect((await preview('netflix.com', '')).status).toBe(401);
    const noCsrf = await request(ctx.app).post('/api/link-preview').set('Cookie', cookie).send({ url: 'netflix.com' });
    expect(noCsrf.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('returns a catalogue match without any outbound request', async () => {
    const res = await preview('https://open.spotify.com/track/abc?si=secret-token');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Spotify', category: 'music', source: 'catalog' });
    expect(calls).toHaveLength(0);
  });

  it('reads an unknown site through the transport; an unreadable one falls back to the address', async () => {
    expect((await preview('https://acme-cloud.com')).body.data).toMatchObject({ name: 'Acme Cloud', source: 'page', category: null, icon: null });
    expect((await preview('unreadable-site.com')).body.data).toMatchObject({ name: 'Unreadable site', source: 'address' });
  });

  it.each([undefined, '', '   ', 5, null, 'x'.repeat(2049)])('rejects an invalid body: %j', async (value) => {
    const res = await preview(value);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown keys', async () => {
    expect((await client(ctx.app, cookie).post('/api/link-preview', { url: 'acme.com', method: 'POST' })).status).toBe(422);
  });

  it.each(['http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1', 'localhost:3001', 'https://10.0.0.1/admin', 'file:///etc/passwd', 'https://intranet.corp', 'https://[::1]/'])(
    'a non-public address (%s) is refused with one fixed message that says nothing about why, and nothing is fetched',
    async (target) => {
      const res = await preview(target);
      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual([{ path: 'url', message: 'Enter the web address of a public website, such as https://example.com.' }]);
      expect(calls).toHaveLength(0);
    },
  );

  it('a name that resolves to a private address is refused with the same message', async () => {
    const privateCtx = createCtx({ linkPreview: { lookup: createSafeLookup(async () => [{ address: '10.1.2.3', family: 4 }]) } });
    try {
      const c = (await registerUser(privateCtx.app)).cookie;
      const res = await client(privateCtx.app, c).post('/api/link-preview', { url: 'https://innocent-looking.com' });
      expect(res.status).toBe(422);
      expect(res.body.error.details[0].message).toBe('Enter the web address of a public website, such as https://example.com.');
    } finally {
      await privateCtx.pool.end();
    }
  });

  it('is rate limited per user (successes count: each call can cost an outbound request)', async () => {
    for (let i = 0; i < 4; i++) expect((await preview(`https://site${i}.com`)).status).toBe(200);
    expect((await preview('https://site5.com')).status).toBe(429);
    const other = (await registerUser(ctx.app)).cookie;
    expect((await preview('https://site6.com', other)).status).toBe(200); // another user is unaffected
  });

  it('never logs the pasted address (it may carry tokens) or anything fetched', async () => {
    await preview('https://acme-cloud.com/pricing?token=SUPER-SECRET-TOKEN');
    await preview('https://127.0.0.1/?token=SUPER-SECRET-TOKEN');
    expect(logs.text()).not.toContain('SUPER-SECRET-TOKEN');
    expect(logs.text()).not.toContain('acme-cloud.com');
    expect(logs.text()).not.toContain('127.0.0.1');
  });
});
