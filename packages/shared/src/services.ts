import { z } from 'zod';
import type { Category } from './subscription.js';

/**
 * A small built-in catalogue of well-known services, used only to save typing: it fills a name, a category, a website link
 * and an emoji. It deliberately holds NO prices, plans, billing dates or cancellation links (those differ per country and
 * plan and go stale), so nothing it fills in can be mistaken for what the user pays.
 */
export interface ServiceTemplate {
  name: string;
  category: Category;
  /** Public home page (https). */
  websiteUrl: string;
  /** One emoji. */
  icon: string;
  /** Other names people type ("hbo", "prime"). */
  aliases?: readonly string[];
  /**
   * Host names that identify this service when a link is pasted. Defaults to the host of `websiteUrl`; use `[]` where that host is
   * shared by unrelated products (amazon.com, github.com) so a link there is never guessed.
   */
  hosts?: readonly string[];
}

const S = (name: string, category: Category, websiteUrl: string, icon: string, extra: Partial<ServiceTemplate> = {}): ServiceTemplate => ({ name, category, websiteUrl, icon, ...extra });

export const SERVICE_CATALOG: readonly ServiceTemplate[] = [
  // video
  S('Netflix', 'video', 'https://www.netflix.com', '🎬'),
  S('Disney+', 'video', 'https://www.disneyplus.com', '🏰', { aliases: ['disney plus', 'disney'] }),
  S('JioHotstar', 'video', 'https://www.hotstar.com', '⭐', { aliases: ['hotstar', 'disney+ hotstar', 'disney hotstar', 'jio hotstar'], hosts: ['hotstar.com', 'jiohotstar.com'] }),
  S('Amazon Prime Video', 'video', 'https://www.primevideo.com', '🎥', { aliases: ['prime video', 'prime'] }),
  S('Hulu', 'video', 'https://www.hulu.com', '📺'),
  S('Max', 'video', 'https://www.max.com', '🎞️', { aliases: ['hbo max', 'hbo'] }),
  S('Apple TV+', 'video', 'https://tv.apple.com', '🍎', { aliases: ['apple tv', 'appletv'] }),
  S('Paramount+', 'video', 'https://www.paramountplus.com', '⛰️', { aliases: ['paramount plus', 'paramount'] }),
  S('Peacock', 'video', 'https://www.peacocktv.com', '🦚'),
  S('YouTube Premium', 'video', 'https://www.youtube.com/premium', '▶️', { aliases: ['youtube', 'yt premium'], hosts: ['youtube.com', 'youtu.be'] }),
  S('Crunchyroll', 'video', 'https://www.crunchyroll.com', '🍥'),
  S('Sony LIV', 'video', 'https://www.sonyliv.com', '📡', { aliases: ['sonyliv'] }),
  S('ZEE5', 'video', 'https://www.zee5.com', '📺', { aliases: ['zee 5'] }),
  S('Discovery+', 'video', 'https://www.discoveryplus.com', '🌍', { aliases: ['discovery plus'] }),
  S('MUBI', 'video', 'https://mubi.com', '🎞️'),
  // music
  S('Spotify', 'music', 'https://www.spotify.com', '🎧'),
  S('Apple Music', 'music', 'https://music.apple.com', '🎵'),
  S('YouTube Music', 'music', 'https://music.youtube.com', '🎶', { aliases: ['yt music'] }),
  S('Amazon Music', 'music', 'https://music.amazon.com', '🎼'),
  S('Tidal', 'music', 'https://tidal.com', '🌊'),
  S('Deezer', 'music', 'https://www.deezer.com', '🎙️'),
  S('JioSaavn', 'music', 'https://www.jiosaavn.com', '🎤', { aliases: ['saavn'] }),
  S('SoundCloud', 'music', 'https://soundcloud.com', '☁️'),
  S('Audible', 'music', 'https://www.audible.com', '📖', { aliases: ['audiobooks'] }),
  // gaming
  S('Xbox Game Pass', 'gaming', 'https://www.xbox.com', '🎮', { aliases: ['xbox', 'game pass'] }),
  S('PlayStation Plus', 'gaming', 'https://www.playstation.com', '🕹️', { aliases: ['ps plus', 'psn', 'playstation'] }),
  S('Nintendo Switch Online', 'gaming', 'https://www.nintendo.com', '🍄', { aliases: ['nintendo'] }),
  S('EA Play', 'gaming', 'https://www.ea.com', '🎯', { aliases: ['ea'] }),
  S('Ubisoft+', 'gaming', 'https://www.ubisoft.com', '🎲', { aliases: ['ubisoft plus'] }),
  S('GeForce NOW', 'gaming', 'https://www.nvidia.com', '🖥️', { aliases: ['nvidia'], hosts: [] }),
  S('Twitch', 'gaming', 'https://www.twitch.tv', '👾'),
  // productivity
  S('Microsoft 365', 'productivity', 'https://www.microsoft.com', '📎', { aliases: ['office 365', 'office', 'microsoft'], hosts: [] }),
  S('Google Workspace', 'productivity', 'https://workspace.google.com', '🗂️', { aliases: ['gsuite', 'g suite'] }),
  S('Notion', 'productivity', 'https://www.notion.so', '📝'),
  S('Evernote', 'productivity', 'https://evernote.com', '🐘'),
  S('Todoist', 'productivity', 'https://todoist.com', '✅'),
  S('Slack', 'productivity', 'https://slack.com', '💬'),
  S('Zoom', 'productivity', 'https://zoom.us', '📹'),
  S('1Password', 'productivity', 'https://1password.com', '🔑', { aliases: ['onepassword'] }),
  S('Bitwarden', 'productivity', 'https://bitwarden.com', '🛡️'),
  S('Canva', 'productivity', 'https://www.canva.com', '🎨'),
  S('Adobe Creative Cloud', 'productivity', 'https://www.adobe.com', '🅰️', { aliases: ['adobe', 'photoshop', 'creative cloud'] }),
  S('Figma', 'productivity', 'https://www.figma.com', '✏️'),
  S('GitHub', 'productivity', 'https://github.com', '🐙', { aliases: ['github pro', 'github copilot', 'copilot'], hosts: [] }),
  // cloud storage
  S('Google One', 'cloud_storage', 'https://one.google.com', '☁️', { aliases: ['google drive', 'google storage'] }),
  S('iCloud+', 'cloud_storage', 'https://www.icloud.com', '☁️', { aliases: ['icloud', 'apple icloud'] }),
  S('Dropbox', 'cloud_storage', 'https://www.dropbox.com', '📦'),
  S('Proton Drive', 'cloud_storage', 'https://proton.me', '🔒', { aliases: ['proton', 'proton mail'] }),
  S('pCloud', 'cloud_storage', 'https://www.pcloud.com', '💾'),
  // AI tools
  S('ChatGPT', 'ai_tools', 'https://chatgpt.com', '🤖', { aliases: ['chatgpt plus', 'openai', 'gpt'], hosts: ['chatgpt.com', 'openai.com'] }),
  S('Claude', 'ai_tools', 'https://claude.ai', '🧠', { aliases: ['claude pro', 'anthropic'], hosts: ['claude.ai', 'anthropic.com'] }),
  S('Perplexity', 'ai_tools', 'https://www.perplexity.ai', '🔎'),
  S('Midjourney', 'ai_tools', 'https://www.midjourney.com', '🖼️'),
  S('Google Gemini', 'ai_tools', 'https://gemini.google.com', '✨', { aliases: ['gemini', 'google ai pro'] }),
  S('Cursor', 'ai_tools', 'https://cursor.com', '⌨️'),
  // news and reading
  S('The New York Times', 'news_reading', 'https://www.nytimes.com', '📰', { aliases: ['nyt', 'new york times'] }),
  S('The Washington Post', 'news_reading', 'https://www.washingtonpost.com', '🗞️', { aliases: ['washington post'] }),
  S('The Economist', 'news_reading', 'https://www.economist.com', '🌐', { aliases: ['economist'] }),
  S('Bloomberg', 'news_reading', 'https://www.bloomberg.com', '📈'),
  S('Medium', 'news_reading', 'https://medium.com', '✍️'),
  S('Substack', 'news_reading', 'https://substack.com', '📬'),
  S('The Hindu', 'news_reading', 'https://www.thehindu.com', '📰', { aliases: ['hindu'] }),
  S('Times of India', 'news_reading', 'https://timesofindia.indiatimes.com', '📰', { aliases: ['toi'] }),
  S('Everand', 'news_reading', 'https://www.everand.com', '📚', { aliases: ['scribd'], hosts: ['everand.com', 'scribd.com'] }),
  S('Kindle Unlimited', 'news_reading', 'https://www.amazon.com', '📚', { aliases: ['kindle'], hosts: [] }),
  // fitness and health
  S('Strava', 'fitness_health', 'https://www.strava.com', '🏃'),
  S('Fitbit Premium', 'fitness_health', 'https://www.fitbit.com', '⌚', { aliases: ['fitbit'] }),
  S('Headspace', 'fitness_health', 'https://www.headspace.com', '🧘'),
  S('Calm', 'fitness_health', 'https://www.calm.com', '🌙'),
  S('MyFitnessPal', 'fitness_health', 'https://www.myfitnesspal.com', '🥗', { aliases: ['mfp'] }),
  S('Peloton', 'fitness_health', 'https://www.onepeloton.com', '🚴', { hosts: ['onepeloton.com', 'peloton.com'] }),
  S('cult.fit', 'fitness_health', 'https://www.cult.fit', '💪', { aliases: ['cultfit', 'cult fit', 'gym'] }),
  // education
  S('Duolingo', 'education', 'https://www.duolingo.com', '🦉'),
  S('Coursera', 'education', 'https://www.coursera.org', '🎓'),
  S('Udemy', 'education', 'https://www.udemy.com', '🧑‍🏫'),
  S('Skillshare', 'education', 'https://www.skillshare.com', '🖌️'),
  S('MasterClass', 'education', 'https://www.masterclass.com', '🎭'),
  S('LinkedIn Learning', 'education', 'https://www.linkedin.com/learning', '💼', { aliases: ['linkedin premium', 'linkedin'], hosts: [] }),
  S('Brilliant', 'education', 'https://brilliant.org', '💡'),
  // shopping and delivery
  S('Amazon Prime', 'shopping', 'https://www.amazon.com', '📦', { aliases: ['amazon', 'prime membership'], hosts: [] }),
  S('Walmart+', 'shopping', 'https://www.walmart.com', '🛒', { aliases: ['walmart plus', 'walmart'] }),
  S('Costco', 'shopping', 'https://www.costco.com', '🏬', { aliases: ['costco membership'] }),
  S('Swiggy One', 'shopping', 'https://www.swiggy.com', '🍔', { aliases: ['swiggy'] }),
  S('Zomato Gold', 'shopping', 'https://www.zomato.com', '🍽️', { aliases: ['zomato'] }),
  S('Uber One', 'shopping', 'https://www.uber.com', '🚗', { aliases: ['uber'] }),
  S('DoorDash DashPass', 'shopping', 'https://www.doordash.com', '🚪', { aliases: ['doordash', 'dashpass'] }),
  // utilities
  S('NordVPN', 'utilities', 'https://nordvpn.com', '🌐', { aliases: ['nord'] }),
  S('ExpressVPN', 'utilities', 'https://www.expressvpn.com', '🛰️', { aliases: ['express vpn'] }),
  S('Surfshark', 'utilities', 'https://surfshark.com', '🦈'),
  S('Proton VPN', 'utilities', 'https://protonvpn.com', '🛡️'),
  // finance
  S('YNAB', 'finance', 'https://www.ynab.com', '💰', { aliases: ['you need a budget'] }),
  S('Quicken', 'finance', 'https://www.quicken.com', '🧾'),
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
  icon: string | null;
  /**
   * catalog: recognised from the host name alone (no request was made).
   * page: the name was read from the page's own title.
   * address: the page could not be read; the name was derived from the host name and should be checked.
   */
  source: 'catalog' | 'page' | 'address';
}
