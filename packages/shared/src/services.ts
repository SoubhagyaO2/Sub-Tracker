import { z } from 'zod';
import type { Category } from './subscription.js';

/**
 * A small built-in catalogue of well-known services, used only to save typing: it fills a name, a category, a website link
 * and, where one ships with the app, a logo. It deliberately holds NO prices, plans, billing dates or cancellation links (those differ per country and
 * plan and go stale), so nothing it fills in can be mistaken for what the user pays.
 */
export interface ServiceTemplate {
  name: string;
  category: Category;
  /** Public home page (https). */
  websiteUrl: string;
  /**
   * A brand-logo key (a Simple Icons slug) when the logo ships with the app; null when it does not (then the app shows a
   * letter tile). Brand logos are trademarks of their owners and are used only to identify the service.
   */
  logo: string | null;
  /** Other names people type ("hbo", "prime"). */
  aliases?: readonly string[];
  /**
   * Host names that identify this service when a link is pasted. Defaults to the host of `websiteUrl`; use `[]` where that host is
   * shared by unrelated products (amazon.com, github.com) so a link there is never guessed.
   */
  hosts?: readonly string[];
}

const S = (name: string, category: Category, websiteUrl: string, logo: string | null, extra: Partial<ServiceTemplate> = {}): ServiceTemplate => ({ name, category, websiteUrl, logo, ...extra });

export const SERVICE_CATALOG: readonly ServiceTemplate[] = [
  // video
  S('Netflix', 'video', 'https://www.netflix.com', 'netflix'),
  S('Disney+', 'video', 'https://www.disneyplus.com', null, { aliases: ['disney plus', 'disney'] }),
  S('JioHotstar', 'video', 'https://www.hotstar.com', null, { aliases: ['hotstar', 'disney+ hotstar', 'disney hotstar', 'jio hotstar'], hosts: ['hotstar.com', 'jiohotstar.com'] }),
  S('Amazon Prime Video', 'video', 'https://www.primevideo.com', null, { aliases: ['prime video', 'prime'] }),
  S('Hulu', 'video', 'https://www.hulu.com', null),
  S('Max', 'video', 'https://www.max.com', 'max', { aliases: ['hbo max', 'hbo'] }),
  S('Apple TV+', 'video', 'https://tv.apple.com', 'appletv', { aliases: ['apple tv', 'appletv'] }),
  S('Paramount+', 'video', 'https://www.paramountplus.com', 'paramountplus', { aliases: ['paramount plus', 'paramount'] }),
  S('Peacock', 'video', 'https://www.peacocktv.com', null),
  S('YouTube Premium', 'video', 'https://www.youtube.com/premium', 'youtube', { aliases: ['youtube', 'yt premium'], hosts: ['youtube.com', 'youtu.be'] }),
  S('Crunchyroll', 'video', 'https://www.crunchyroll.com', 'crunchyroll'),
  S('Sony LIV', 'video', 'https://www.sonyliv.com', null, { aliases: ['sonyliv'] }),
  S('ZEE5', 'video', 'https://www.zee5.com', null, { aliases: ['zee 5'] }),
  S('Discovery+', 'video', 'https://www.discoveryplus.com', null, { aliases: ['discovery plus'] }),
  S('MUBI', 'video', 'https://mubi.com', 'mubi'),
  // music
  S('Spotify', 'music', 'https://www.spotify.com', 'spotify'),
  S('Apple Music', 'music', 'https://music.apple.com', 'applemusic'),
  S('YouTube Music', 'music', 'https://music.youtube.com', 'youtubemusic', { aliases: ['yt music'] }),
  S('Amazon Music', 'music', 'https://music.amazon.com', null),
  S('Tidal', 'music', 'https://tidal.com', 'tidal'),
  S('Deezer', 'music', 'https://www.deezer.com', 'deezer'),
  S('JioSaavn', 'music', 'https://www.jiosaavn.com', null, { aliases: ['saavn'] }),
  S('SoundCloud', 'music', 'https://soundcloud.com', 'soundcloud'),
  S('Audible', 'music', 'https://www.audible.com', 'audible', { aliases: ['audiobooks'] }),
  // gaming
  S('Xbox Game Pass', 'gaming', 'https://www.xbox.com', null, { aliases: ['xbox', 'game pass'] }),
  S('PlayStation Plus', 'gaming', 'https://www.playstation.com', 'playstation', { aliases: ['ps plus', 'psn', 'playstation'] }),
  S('Nintendo Switch Online', 'gaming', 'https://www.nintendo.com', null, { aliases: ['nintendo'] }),
  S('EA Play', 'gaming', 'https://www.ea.com', 'ea', { aliases: ['ea'] }),
  S('Ubisoft+', 'gaming', 'https://www.ubisoft.com', 'ubisoft', { aliases: ['ubisoft plus'] }),
  S('GeForce NOW', 'gaming', 'https://www.nvidia.com', 'nvidia', { aliases: ['nvidia'], hosts: [] }),
  S('Twitch', 'gaming', 'https://www.twitch.tv', 'twitch'),
  // productivity
  S('Microsoft 365', 'productivity', 'https://www.microsoft.com', null, { aliases: ['office 365', 'office', 'microsoft'], hosts: [] }),
  S('Google Workspace', 'productivity', 'https://workspace.google.com', null, { aliases: ['gsuite', 'g suite'] }),
  S('Notion', 'productivity', 'https://www.notion.so', 'notion'),
  S('Evernote', 'productivity', 'https://evernote.com', 'evernote'),
  S('Todoist', 'productivity', 'https://todoist.com', 'todoist'),
  S('Slack', 'productivity', 'https://slack.com', null),
  S('Zoom', 'productivity', 'https://zoom.us', 'zoom'),
  S('1Password', 'productivity', 'https://1password.com', '1password', { aliases: ['onepassword'] }),
  S('Bitwarden', 'productivity', 'https://bitwarden.com', 'bitwarden'),
  S('Canva', 'productivity', 'https://www.canva.com', null),
  S('Adobe Creative Cloud', 'productivity', 'https://www.adobe.com', null, { aliases: ['adobe', 'photoshop', 'creative cloud'] }),
  S('Figma', 'productivity', 'https://www.figma.com', 'figma'),
  S('GitHub', 'productivity', 'https://github.com', 'github', { aliases: ['github pro', 'github copilot', 'copilot'], hosts: [] }),
  // cloud storage
  S('Google One', 'cloud_storage', 'https://one.google.com', null, { aliases: ['google drive', 'google storage'] }),
  S('iCloud+', 'cloud_storage', 'https://www.icloud.com', 'icloud', { aliases: ['icloud', 'apple icloud'] }),
  S('Dropbox', 'cloud_storage', 'https://www.dropbox.com', 'dropbox'),
  S('Proton Drive', 'cloud_storage', 'https://proton.me', 'protondrive', { aliases: ['proton', 'proton mail'] }),
  S('pCloud', 'cloud_storage', 'https://www.pcloud.com', null),
  // AI tools
  S('ChatGPT', 'ai_tools', 'https://chatgpt.com', null, { aliases: ['chatgpt plus', 'openai', 'gpt'], hosts: ['chatgpt.com', 'openai.com'] }),
  S('Claude', 'ai_tools', 'https://claude.ai', 'claude', { aliases: ['claude pro', 'anthropic'], hosts: ['claude.ai', 'anthropic.com'] }),
  S('Perplexity', 'ai_tools', 'https://www.perplexity.ai', 'perplexity'),
  S('Midjourney', 'ai_tools', 'https://www.midjourney.com', null),
  S('Google Gemini', 'ai_tools', 'https://gemini.google.com', 'googlegemini', { aliases: ['gemini', 'google ai pro'] }),
  S('Cursor', 'ai_tools', 'https://cursor.com', 'cursor'),
  // news and reading
  S('The New York Times', 'news_reading', 'https://www.nytimes.com', 'newyorktimes', { aliases: ['nyt', 'new york times'] }),
  S('The Washington Post', 'news_reading', 'https://www.washingtonpost.com', 'thewashingtonpost', { aliases: ['washington post'] }),
  S('The Economist', 'news_reading', 'https://www.economist.com', null, { aliases: ['economist'] }),
  S('Bloomberg', 'news_reading', 'https://www.bloomberg.com', null),
  S('Medium', 'news_reading', 'https://medium.com', 'medium'),
  S('Substack', 'news_reading', 'https://substack.com', 'substack'),
  S('The Hindu', 'news_reading', 'https://www.thehindu.com', null, { aliases: ['hindu'] }),
  S('Times of India', 'news_reading', 'https://timesofindia.indiatimes.com', null, { aliases: ['toi'] }),
  S('Everand', 'news_reading', 'https://www.everand.com', null, { aliases: ['scribd'], hosts: ['everand.com', 'scribd.com'] }),
  S('Kindle Unlimited', 'news_reading', 'https://www.amazon.com', null, { aliases: ['kindle'], hosts: [] }),
  // fitness and health
  S('Strava', 'fitness_health', 'https://www.strava.com', 'strava'),
  S('Fitbit Premium', 'fitness_health', 'https://www.fitbit.com', 'fitbit', { aliases: ['fitbit'] }),
  S('Headspace', 'fitness_health', 'https://www.headspace.com', 'headspace'),
  S('Calm', 'fitness_health', 'https://www.calm.com', null),
  S('MyFitnessPal', 'fitness_health', 'https://www.myfitnesspal.com', null, { aliases: ['mfp'] }),
  S('Peloton', 'fitness_health', 'https://www.onepeloton.com', 'peloton', { hosts: ['onepeloton.com', 'peloton.com'] }),
  S('cult.fit', 'fitness_health', 'https://www.cult.fit', null, { aliases: ['cultfit', 'cult fit', 'gym'] }),
  // education
  S('Duolingo', 'education', 'https://www.duolingo.com', 'duolingo'),
  S('Coursera', 'education', 'https://www.coursera.org', 'coursera'),
  S('Udemy', 'education', 'https://www.udemy.com', 'udemy'),
  S('Skillshare', 'education', 'https://www.skillshare.com', 'skillshare'),
  S('MasterClass', 'education', 'https://www.masterclass.com', null),
  S('LinkedIn Learning', 'education', 'https://www.linkedin.com/learning', null, { aliases: ['linkedin premium', 'linkedin'], hosts: [] }),
  S('Brilliant', 'education', 'https://brilliant.org', null),
  // shopping and delivery
  S('Amazon Prime', 'shopping', 'https://www.amazon.com', null, { aliases: ['amazon', 'prime membership'], hosts: [] }),
  S('Walmart+', 'shopping', 'https://www.walmart.com', null, { aliases: ['walmart plus', 'walmart'] }),
  S('Costco', 'shopping', 'https://www.costco.com', null, { aliases: ['costco membership'] }),
  S('Swiggy One', 'shopping', 'https://www.swiggy.com', 'swiggy', { aliases: ['swiggy'] }),
  S('Zomato Gold', 'shopping', 'https://www.zomato.com', 'zomato', { aliases: ['zomato'] }),
  S('Uber One', 'shopping', 'https://www.uber.com', 'uber', { aliases: ['uber'] }),
  S('DoorDash DashPass', 'shopping', 'https://www.doordash.com', 'doordash', { aliases: ['doordash', 'dashpass'] }),
  // utilities
  S('NordVPN', 'utilities', 'https://nordvpn.com', 'nordvpn', { aliases: ['nord'] }),
  S('ExpressVPN', 'utilities', 'https://www.expressvpn.com', 'expressvpn', { aliases: ['express vpn'] }),
  S('Surfshark', 'utilities', 'https://surfshark.com', 'surfshark'),
  S('Proton VPN', 'utilities', 'https://protonvpn.com', 'protonvpn'),
  // finance
  S('YNAB', 'finance', 'https://www.ynab.com', null, { aliases: ['you need a budget'] }),
  S('Quicken', 'finance', 'https://www.quicken.com', null),
];

// ───────────── matching ─────────────

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim();

interface Indexed {
  service: ServiceTemplate;
  name: string;
  aliases: string[];
}
const INDEX: Indexed[] = SERVICE_CATALOG.map((service) => ({ service, name: norm(service.name), aliases: (service.aliases ?? []).map(norm) }));

function rank(q: string, e: Indexed): number {
  if (e.name === q) return 0;
  if (e.aliases.includes(q)) return 1;
  if (e.name.startsWith(q)) return 2;
  if (e.aliases.some((a) => a.startsWith(q))) return 3;
  if (e.name.split(' ').some((w) => w.startsWith(q))) return 4;
  if (q.length >= 3 && (e.name.includes(q) || e.aliases.some((a) => a.includes(q)))) return 5;
  return -1;
}

/** Best matches first. Empty for an empty query. */
export function searchServices(query: string, limit = 6): ServiceTemplate[] {
  const q = norm(query);
  if (!q) return [];
  return INDEX.map((e) => ({ e, r: rank(q, e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e.service);
}

const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
const HOST_INDEX: { host: string; service: ServiceTemplate }[] = SERVICE_CATALOG.flatMap((service) =>
  (service.hosts ?? [hostOf(service.websiteUrl)]).map((h) => ({ host: h.toLowerCase().replace(/^www\./, ''), service })),
).sort((a, b) => b.host.length - a.host.length); // most specific host first (music.apple.com before apple.com)

/** The service a host name belongs to ("www.netflix.com" -> Netflix), or null. Never guesses for shared hosts. */
export function serviceForHostname(hostname: string): ServiceTemplate | null {
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  for (const { host, service } of HOST_INDEX) if (h === host || h.endsWith(`.${host}`)) return service;
  return null;
}

// ───────────── link preview contract (POST /api/link-preview) ─────────────

export const linkPreviewSchema = z.strictObject({ url: z.string().trim().min(1, 'Paste a web address.').max(2048, 'That address is too long.') });
export type LinkPreviewInput = z.infer<typeof linkPreviewSchema>;

export interface LinkPreview {
  name: string;
  websiteUrl: string;
  /** Only set when the link is a known service. */
  category: Category | null;
  /** A built-in logo key (see ServiceTemplate.logo); only set for a known service that has one. */
  icon: string | null;
  /**
   * catalog: recognised from the host name alone (no request was made).
   * page: the name was read from the page's own title.
   * address: the page could not be read; the name was derived from the host name and should be checked.
   */
  source: 'catalog' | 'page' | 'address';
}
