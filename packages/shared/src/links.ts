export type LinkKind = 'gdrive' | 'shortener' | 'stream' | 'torrent' | 'spam' | 'other' | 'download';

export interface ClassifiedLink {
  url: string;
  kind: LinkKind;
  label: string;
}

/** Google Drive file hosts — the primary Hindi-audio source (§4.3). */
const GDRIVE = new Set(['drive.google.com', 'docs.google.com']);

/** Link gates that sit between the forum and the real file (§4.3 recon). */
const SHORTENERS = new Set([
  'lulust.com',
  'luluvido.com', // distinct host, note the "vido" spelling
  'drakkar.st',
  'siteget.net',
  'freeproxy.io',
  // Discovered in gdrive-only.html: the actual gate in front of every Drive link.
  'adrinolinks.in',
  'cyberloom.best', // /l/<id> "download-button" gate seen in every multi-quality fixture
  'bit.ly',
  'tinyurl.com',
  'ouo.io',
  'shrinke.me',
  'gplinks.co',
  'za.gl',
  'adf.ly',
  'shrinkme.io',
  'clicksfly.com',
  'urlshortx.com',
]);

/** Direct video hosts. */
const STREAM = new Set(['luluvdo.com', 'dood.to', 'doodstream.com', 'mp4upload.com']);

/**
 * Noise inside a post body: channel invites and the screenshot CDN the uploaders use.
 * Deliberately a host list, not an extension test — poster and theme images are hosted
 * on pbs.twimg.com, i.pinimg.com, cdn.jsdelivr.net and the forum's own uploads/ folder,
 * and a `/\.png$/` style rule would swallow all of them as spam.
 */
/**
 * Site chrome, present on every topic page: the Telegram banner, the screenshot CDN, and the
 * `streamdady` player banner (one per topic — 8,682 rows for 8,682 topics). Chrome must never
 * count as "this post has a link", or every magnet-less post looks like an external download.
 */
const NOISE_HOSTS = new Set(['t.me', 'telegram.me', 'imageride.net', 'streamdady.com']);

const ATTACHMENT = /attachment\.php/i;

/**
 * True when the link leaves the forum for a real external host.
 *
 * `classifyLink` cannot answer this: a host name does not say whether a link is a download or a
 * screenshot. The caller that has the anchor (and can see it wraps an image) makes the call.
 */
export function isExternalLink(url: string): boolean {
  const host = hostOf(url.replace(/&amp;/gi, '&'));
  if (host === '') return false;
  return !/(^|\.)1tamilmv\.[a-z.]+$/i.test(host);
}
const OPEN_REDIRECT = /\/o\.php\?u=/i;

/**
 * Lowercased host with `www.` stripped. Protocol-relative URLs (`//host/path`, common in
 * the forum's own markup) are parsed as https. Unparseable input yields ''.
 */
function hostOf(url: string): string {
  const candidate = url.startsWith('//') ? `https:${url}` : url;
  try {
    return new URL(candidate).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isNoiseHost(host: string): boolean {
  return NOISE_HOSTS.has(host) || host.endsWith('.imageride.net');
}

/**
 * Classifies one outbound link from a topic page. Never throws: relative paths, `#`,
 * magnets and junk all fall through to `other`.
 *
 * `1tamilmv.*` mirrors and forum-internal URLs are `other` — they are navigation, not
 * download targets — and the mirror list is wider than the `.io` in the recon notes.
 */
export function classifyLink(url: string): ClassifiedLink {
  // captured hrefs still carry HTML entities; match on the decoded form, echo the original
  const decoded = url.replace(/&amp;/gi, '&');
  const host = hostOf(decoded);
  const label = host;

  if (GDRIVE.has(host)) return { url, kind: 'gdrive', label };
  if (ATTACHMENT.test(decoded)) return { url, kind: 'torrent', label: 'torrent file' };
  if (isNoiseHost(host)) return { url, kind: 'spam', label };
  if (STREAM.has(host)) return { url, kind: 'stream', label };
  if (SHORTENERS.has(host) || OPEN_REDIRECT.test(decoded)) return { url, kind: 'shortener', label };
  return { url, kind: 'other', label };
}
