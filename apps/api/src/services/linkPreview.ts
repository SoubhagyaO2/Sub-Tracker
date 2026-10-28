import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { serviceForHostname, type LinkPreview } from '@subcycle/shared';

/**
 * "Fill from a pasted link": turns a web address into a suggested name and website link.
 *
 * This is the one place the server makes an outbound request to an address a user chose, so it is written to be safe against
 * server-side request forgery (SSRF):
 *  - https only, port 443 only, no credentials in the URL, no IP-address hosts, no single-label or internal-looking names;
 *  - every address the name resolves to must be a public, globally routable one, and the connection is made to THAT validated
 *    address (the check happens inside the socket's own DNS lookup, so a name cannot resolve to something different between the
 *    check and the connection: no DNS-rebinding window);
 *  - redirects are followed by hand (at most 3) and every hop is validated again;
 *  - 4 s per attempt, 256 KB at most, HTML only, no cookies or other credentials are ever sent.
 * It reads only the page title / site name. It never reads prices, plans or billing dates.
 */

export class LinkRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LinkRejected';
  }
}

// ───────────── address checks ─────────────

// Separate lists per family: Node's BlockList matches an IPv4 address against IPv6 rules as an IPv4-mapped address, so a single
// list holding ::ffff:0:0/96 would (wrongly) deny every IPv4 address.
const denied4 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied4.addSubnet(addr, prefix, 'ipv4');
const denied6 = new net.BlockList();
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) denied6.addSubnet(addr, prefix, 'ipv6');
const globalUnicast6 = new net.BlockList();
globalUnicast6.addSubnet('2000::', 3, 'ipv6'); // IPv6 only counts as public inside 2000::/3

/** True only for a globally routable unicast address. Everything unknown is refused. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !denied4.check(address, 'ipv4');
  if (family === 6) return globalUnicast6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
  return false;
}

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.private', '.localdomain', '.home.arpa', '.arpa', '.onion', '.invalid', '.test', '.example'];
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/** Parses and validates a pasted address. Throws LinkRejected for anything that is not a plain public https web address. */
export function parsePublicUrl(raw: string): URL {
  let text = raw.trim();
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\s]/.test(text)) throw new LinkRejected('whitespace or control characters');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`; // "netflix.com" is fine
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LinkRejected('not a URL');
  }
  if (url.protocol === 'http:') url.protocol = 'https:'; // never fetch in clear text: try https instead
  if (url.protocol !== 'https:') throw new LinkRejected('scheme');
  if (url.username || url.password) throw new LinkRejected('credentials');
  if (url.port !== '' && url.port !== '443') throw new LinkRejected('port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host) || host.startsWith('[')) throw new LinkRejected('ip literal');
  if (!HOSTNAME.test(host)) throw new LinkRejected('hostname');
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1))) throw new LinkRejected('internal name');
  url.hostname = host;
  url.hash = '';
  return url;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** A socket DNS lookup that resolves, validates EVERY returned address, and hands back only validated ones. */
export function createSafeLookup(resolve: Resolver = systemResolver): net.LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) return callback(new LinkRejected('resolves to a non-public address'));
        if (options?.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: unknown) => callback(err),
    );
  }) as net.LookupFunction;
}

// ───────────── fetching ─────────────

export interface PageResponse {
  status: number;
  location?: string;
  contentType?: string;
  /** Start of the body (the transport stops reading after MAX_BODY_BYTES or `</head>`). */
  body: string;
}
export type Transport = (url: URL, lookup: net.LookupFunction) => Promise<PageResponse>;

export const MAX_BODY_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;

export const httpsTransport: Transport = (url, lookup) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup,
        servername: url.hostname,
        agent: false, // no connection reuse and no shared state between users' requests
        headers: { Host: url.hostname, 'User-Agent': 'SubCycle-LinkPreview/1.0 (+name lookup only)', Accept: 'text/html', 'Accept-Encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = { location: res.headers.location, contentType: res.headers['content-type'] };
        if (status !== 200) {
          res.resume();
          res.destroy();
          return resolve({ status, ...headers, body: '' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => {
          res.destroy();
          resolve({ status, ...headers, body: Buffer.concat(chunks).toString('utf8') });
        };
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY_BYTES || /<\/head>/i.test(chunk.toString('latin1'))) finish();
        });
        res.on('end', finish);
        res.on('error', reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });

// ───────────── reading a name ─────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', iacute: 'í', oacute: 'ó', ocirc: 'ô', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 31 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = (name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
    const k = attrs('property') ?? attrs('name');
    if ((k?.[1] ?? k?.[2])?.toLowerCase() === key) {
      const c = attrs('content');
      const v = c?.[1] ?? c?.[2];
      if (v) return v;
    }
  }
  return null;
}

/** "Netflix - Watch TV Shows Online" -> "Netflix". Only the page's own text is used; nothing is invented. */
export function extractName(html: string): string | null {
  const head = html.slice(0, MAX_BODY_BYTES);
  const raw = metaContent(head, 'og:site_name') ?? metaContent(head, 'application-name') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? metaContent(head, 'og:title');
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  const text = decode(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const first = text.split(/\s+[|–—·•:-]\s+|\s*[|–—·•]\s*/)[0]?.trim() ?? '';
  const name = first.slice(0, 80).trim();
  return name.length >= 2 ? name : null;
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
/** "www.some-shop.co.uk" -> "Some shop". Used only when a page cannot be read; the UI tells the user to check it. */
export function nameFromHost(hostname: string): string {
  const parts = hostname.replace(/^www\./, '').split('.');
  const label = parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]!) ? parts[parts.length - 3]! : (parts[parts.length - 2] ?? parts[0]!);
  const words = label.replace(/-/g, ' ').trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 80) || hostname;
}

// ───────────── entry point ─────────────

export interface PreviewDeps {
  transport?: Transport;
  lookup?: net.LookupFunction;
}

/**
 * @throws LinkRejected when the address is not a public https web address (the only failure the caller reports as an error).
 * Network failures, timeouts, non-HTML or non-200 answers degrade to a name derived from the host name.
 */
export async function previewLink(raw: string, deps: PreviewDeps = {}): Promise<LinkPreview> {
  const transport = deps.transport ?? httpsTransport;
  const lookup = deps.lookup ?? createSafeLookup();
  let url = parsePublicUrl(raw);

  const known = serviceForHostname(url.hostname);
  if (known) return { name: known.name, websiteUrl: known.websiteUrl, category: known.category, icon: known.logo, source: 'catalog' };

  let page: PageResponse | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await transport(url, lookup);
      if (res.status >= 300 && res.status < 400 && res.location) {
        if (hop === MAX_REDIRECTS) break;
        url = parsePublicUrl(new URL(res.location, url).href); // every hop is validated again
        const again = serviceForHostname(url.hostname);
        if (again) return { name: again.name, websiteUrl: again.websiteUrl, category: again.category, icon: again.logo, source: 'catalog' };
        continue;
      }
      if (res.status === 200 && /^text\/html\b/i.test(res.contentType ?? '')) page = res;
      break;
    }
  } catch (err) {
    if (err instanceof LinkRejected) throw err; // a non-public redirect target or resolution is a rejection, never a fetch
    page = null; // timeout, refused, DNS or TLS failure, ...: fall back to the host name
  }

  const fromPage = page ? extractName(page.body) : null;
  return {
    name: fromPage ?? nameFromHost(url.hostname),
    websiteUrl: url.origin,
    category: null,
    icon: null,
    source: fromPage ? 'page' : 'address',
  };
}
