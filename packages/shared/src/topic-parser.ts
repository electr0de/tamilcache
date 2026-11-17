/**
 * Topic page → quality blocks.
 *
 * The selector for a block is not "a line with a size and a source tag": every topic body
 * repeats a topic-level *summary* line (with sizes and a source tag) up to three times before
 * the topic URL, and `multi-quality.html` has 20 such candidate lines for 7 magnets.
 *
 * A block is anchored on a line that **ends with `:`** and carries a size and a source tag
 * (`isBlockHeaderLine`); its magnet is the first magnet occurring after that line, and its
 * attachment is the torrent link between the header and that magnet. See
 * `test/fixtures/MANIFEST.md` → "THE PARSING RULE THIS SET PROVES".
 */
import { blockHeaderText, parseAudioLangs, parseBlockHeader, stripMirrorPrefix } from './block-header.js';
import { classifyLink, isExternalLink, type ClassifiedLink } from './links.js';
import { magnetInfohash } from './magnet.js';
import { resolutionBySizeFromSummary } from './summary-resolution.js';

export interface ParsedVariant {
  /** Title and year as stated in this block's own header line. */
  title: string;
  year: number | null;
  qualityLabel: string | null;
  resolution: string | null;
  sourceTagRaw: string;
  codec: string | null;
  audioCodecs: string | null;
  audioLangs: string[];
  sizeBytes: number;
  /** Null when the block has only a `.torrent`; the caller derives it from the attachment. */
  infohash: string | null;
  magnet: string | null;
  torrentUrl: string | null;
  /**
   * Languages named by the topic-level places (title + labelled prose), deduped. Kept separate
   * from `audioLangs` because a block header is per-block evidence and the topic title is not:
   * a Tamil-dub block must not inherit `english` from the topic title.
   */
  topicAudioLangs: string[];
  /**
   * How many distinct places on the page named audio languages — 0..3 out of {title, header,
   * prose}. `classify()` needs the count, not just the union, to tell "two places agree" from
   * "one uploader string said it once".
   */
  audioSourceCount: number;
}

export interface ParsedTopic {
  sourceTopicId: number | null;
  slug: string;
  rawTitle: string;
  poster: string | null;
  variants: ParsedVariant[];
  links: ClassifiedLink[];
}

export interface BodyLine {
  text: string;
  /** Offset of the line's first non-space character in the body HTML. */
  offset: number;
}

interface MagnetRef {
  infohash: string;
  magnet: string;
  pos: number;
}

interface TorrentRef {
  url: string;
  pos: number;
}

const BODY_MARKER = /data-role=['"]commentContent['"]/i;

/**
 * A post has a download when its **first** post carries a magnet or a `.torrent` attachment.
 *
 * Deliberately not the whole document: replies are other people's posts. A magnet pasted into a
 * reply used to make a DDL post throw `topic produced no variants`, which is how 261 working
 * pages ended up in the dead-letter list.
 */
export function hasDownload(firstPostHtml: string): boolean {
  if (/href=['"]magnet:\?/i.test(firstPostHtml)) return true;
  return /href=['"][^'"]*attachment\.php[^'"]*['"]/i.test(firstPostHtml);
}
const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>|<br\b[^>]*>|<[^>]+>|[^<]+/gi;
const BLOCK_BOUNDARY = /^(?:<(?:p|div|li|tr|h[1-6]|blockquote|section|article)\b|<\/(?:p|div|li|tr|h[1-6]|blockquote|section|article)\b)/i;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39|#0?39);/gi, (entity) =>
      ENTITIES[entity.toLowerCase()] ?? ENTITIES[entity] ?? entity,
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

/**
 * The first post body. Falls back to the whole document when the (IPS-specific) marker is
 * missing, so markup drift degrades to "fewer guarantees" instead of "zero variants".
 */
export function firstPostBody(html: string): string {
  const marker = BODY_MARKER.exec(html);
  if (!marker) return html;
  const open = html.lastIndexOf('<div', marker.index);
  const start = open < 0 ? marker.index : open;
  const walker = /<div\b|<\/div>/gi;
  walker.lastIndex = start;
  let depth = 0;
  for (let m = walker.exec(html); m; m = walker.exec(html)) {
    if (m[0].length === 4) depth += 1;
    else {
      depth -= 1;
      if (depth === 0) return html.slice(start, m.index + m[0].length);
    }
  }
  return html.slice(start);
}

/**
 * Strips tags to lines, remembering where each line started in the source so that block
 * headers and magnets (found by byte offset) stay comparable.
 *
 * `<br>` and block-level tags close a line; inline tags become a space so `<span>:</span>`
 * still yields a line that ends with `:`.
 */
function textLines(body: string): BodyLine[] {
  let text = '';
  const sourceOffsets: number[] = [];
  const push = (chunk: string, at: number): void => {
    for (let i = 0; i < chunk.length; i += 1) {
      text += chunk[i];
      sourceOffsets.push(at);
    }
  };

  for (const m of body.matchAll(TOKEN)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (token.startsWith('<')) {
      const closesLine =
        token.startsWith('<!') ||
        /^<(?:script|style)\b/i.test(token) ||
        /^<br\b/i.test(token) ||
        BLOCK_BOUNDARY.test(token);
      push(closesLine ? '\n' : ' ', at);
      continue;
    }
    push(decodeEntities(token), at);
  }

  const lines: BodyLine[] = [];
  let lineStart = 0;
  const flush = (end: number): void => {
    const raw = text.slice(lineStart, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length;
      lines.push({
        text: trimmed.replace(/[ \t\u00a0]+/g, ' '),
        offset: sourceOffsets[lineStart + lead] ?? 0,
      });
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      flush(i);
      lineStart = i + 1;
    }
  }
  flush(text.length);
  return lines;
}

/**
 * Lines of the first post body — the scope the parser actually scans for blocks.
 * Exported so tests can assert the anchor rule against the same segmentation.
 */
export function topicBodyLines(html: string): BodyLine[] {
  return textLines(firstPostBody(html));
}

/**
 * Lines of the whole document — the scope MANIFEST.md measures the anchor rule in
 * ("lines that end with `:` and contain both a size and a source tag"). Exported because a
 * naive whole-page selector is what the colon rule has to beat.
 */
export function htmlLines(html: string): BodyLine[] {
  return textLines(html);
}

/**
 * A prose line that *states* the audio rather than merely containing a language word. Blocks
 * (`- HQ Clean Audio :`) are excluded by the caller, so the cue only has to recognise the
 * label forms the site uses: `Audio Tracks:`, `Audio:`, `Original Audio(s)`, `Org Auds`,
 * `Tamil Dubbed`, `Multi Audio`.
 */
const AUDIO_CUE = /(?:\baudio\b|\bauds?\b|\bdubb?ed\b)/i;

/** Whitespace-normalised comparison key, so a title and its body repeat compare equal. */
function lineKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Topic-level language evidence: the `og:title` and any labelled prose line.
 *
 * `<title>` is deliberately **not** used as a title source: it appends the forum name, and forum
 * names contain language words (`Tamil Language`), which would inject a language the release
 * never claimed. The attachment anchor is not a place either — it repeats the header verbatim.
 */
function topicAudioEvidence(
  html: string,
  lines: BodyLine[],
  title: string,
  isHeader: (line: BodyLine) => boolean,
): { titleLangs: string[]; proseLangs: string[] } {
  const ogTitle = metaContent(html, 'og:title');
  const titleLangs = ogTitle ? parseAudioLangs(ogTitle) : [];
  const titleKey = lineKey(title);

  const prose = new Set<string>();
  for (const line of lines) {
    if (isHeader(line)) continue;
    // The first line of most posts is the topic title verbatim; it is the same place, not a second.
    if (lineKey(line.text) === titleKey) continue;
    // An attachment anchor is the block header with a file name appended — same place again.
    if (/\.torrent$/i.test(line.text.trim())) continue;
    if (!AUDIO_CUE.test(line.text)) continue;
    for (const lang of parseAudioLangs(line.text)) prose.add(lang);
  }

  return { titleLangs, proseLangs: [...prose] };
}

function collectMagnets(body: string): MagnetRef[] {
  const out: MagnetRef[] = [];
  for (const m of body.matchAll(/href=['"](magnet:\?[^'"]*)['"]/gi)) {
    const raw = m[1];
    if (!raw || m.index === undefined) continue;
    const infohash = magnetInfohash(raw);
    if (infohash) out.push({ infohash, magnet: decodeEntities(raw), pos: m.index });
  }
  return out;
}

function collectTorrents(body: string): TorrentRef[] {
  const out: TorrentRef[] = [];
  for (const m of body.matchAll(/href=['"]([^'"]*attachment\.php[^'"]*)['"]/gi)) {
    if (m[1] && m.index !== undefined) out.push({ url: decodeEntities(m[1]), pos: m.index });
  }
  return out;
}

function absoluteUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function metaContent(html: string, key: string): string | null {
  const keyRe = new RegExp(`\\b(?:property|name)=['"]${key}['"]`, 'i');
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!keyRe.test(tag)) continue;
    const content = /\bcontent=['"]([^'"]*)['"]/i.exec(tag)?.[1];
    if (content !== undefined) return decodeEntities(content);
  }
  return null;
}

interface TopicRef {
  id: number;
  slug: string;
}

/** `…/forums/topic/187596-a-minecraft-movie…/` → `{ id: 187596, slug: 'a-minecraft-movie…' }`. */
function topicRef(url: string): TopicRef | null {
  // Any non-slash run after the id: slugs can start with a percent-encoded symbol (`%E2%97%97` =
  // ◗) or a zero-width space (`%E2%80%8B`). Requiring `[a-z0-9]` as the first character silently
  // dropped 79 topics, and a dropped ref is a `no topic id` dead letter.
  const m = /forums\/topic\/(\d+)-([^/'"?#\s]+)/i.exec(decodeEntities(url));
  if (!m?.[1] || !m[2]) return null;
  // every page links the "topic/183-0" navigation entry; 0 is never a real slug
  if (Number(m[1]) === 0 || m[2] === '0') return null;
  return { id: Number(m[1]), slug: safeDecode(m[2]).toLowerCase() };
}

/** `decodeURIComponent` throws on a malformed escape; a slug is not worth failing a page over. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The ref a topic URL itself carries. Used when we never got a page to parse (a 404 has no
 * canonical link), so a dead topic can still be recorded against its id instead of vanishing.
 */
export function topicRefFromUrl(url: string): TopicRef | null {
  return topicRef(url);
}

function resolveTopicRef(html: string): TopicRef | null {
  const canonical = /<link\b[^>]*\brel=['"]canonical['"][^>]*>/i.exec(html)?.[0];
  const canonicalHref = canonical ? /\bhref=['"]([^'"]+)['"]/i.exec(canonical)?.[1] : undefined;
  if (canonicalHref) {
    const fromCanonical = topicRef(canonicalHref);
    if (fromCanonical) return fromCanonical;
  }
  for (const m of html.matchAll(/href=['"]([^'"]*forums\/topic\/[^'"]*)['"]/gi)) {
    if (!m[1]) continue;
    const ref = topicRef(m[1]);
    if (ref) return ref;
  }
  return null;
}

function rawTitleOf(html: string): string {
  const og = metaContent(html, 'og:title');
  const tag = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
  const raw = og ?? (tag ? decodeEntities(tag).replace(/\s+-\s*1TamilMV.*$/i, '') : '');
  return raw.replace(/\s+/g, ' ').trim();
}

/** Poster: an `<img src>` of the post body, never the `href` of its lightbox anchor. */
function posterOf(body: string, baseUrl: string): string | null {
  for (const m of body.matchAll(/<img\b[^>]*\bsrc=['"]([^'"]+)['"]/gi)) {
    const src = m[1];
    if (!src || !/^https?:\/\//i.test(src)) continue;
    if (/\/uploads\//i.test(src) || /\.gif(?:$|\?)/i.test(src)) continue;
    return absoluteUrl(src, baseUrl);
  }
  return null;
}

/** Page hrefs, deduped, with the magnet hrefs (already attached to variants) dropped. */
/**
 * Links a reader could actually click for the file: anchors of the **first post**, not the page.
 *
 * The document carries 130–170 `href`s (stylesheets, nav, footer widgets, sibling topics) against
 * 14–25 in the post, so scanning the page filled `links` with navigation and made a post with an
 * unnoticed gate look link-less. An anchor wrapping an `<img>` is a screenshot/poster link, not a
 * download, so it is skipped too.
 */
/** A URL written as text: `https://gplinks.co/qSoh`, `www.host/x`. Trailing punctuation is trimmed. */
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>"'`\])}]+/gi;

function linksOf(body: string): ClassifiedLink[] {
  const seen = new Set<string>();
  const links: ClassifiedLink[] = [];
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1] ?? '';
    const inner = match[2] ?? '';
    const raw = /href=['"]([^'"]+)['"]/i.exec(attributes)?.[1];
    if (!raw) continue;
    if (/^magnet:/i.test(raw)) continue;
    // An anchor wrapping an image is a screenshot/poster link, not a download.
    if (/<img\b/i.test(inner)) continue;
    const url = decodeEntities(raw);
    if (url === '' || url === '#' || /^javascript:/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const link = classifyLink(url);
    // A host the shortener list does not know is still a link a person can follow:
    // `shrinkme.click`, `xtglinks.com` and `tpi.li` were all unknown, and calling them `other`
    // recorded the post as having no link at all. Forum-internal navigation keeps that label.
    links.push(link.kind === 'other' && isExternalLink(url) ? { ...link, kind: 'download' } : link);
  }

  // Some posters paste the URL as text instead of linking it (`https://gplinks.co/qSoh`), and an
  // anchors-only scan filed those posts as `no_link` — a known shortener, invisible. Read the
  // *visible* text for URLs too: stripping tags first keeps `src=`/stylesheet hosts out.
  const visible = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&');
  for (const match of visible.matchAll(BARE_URL)) {
    const url = match[0].replace(/[.,;:]+$/, '');
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    const link = classifyLink(url);
    links.push(link.kind === 'other' && isExternalLink(url) ? { ...link, kind: 'download' } : link);
  }
  return links;
}

export function parseTopicPage(html: string, baseUrl: string): ParsedTopic {
  const ref = resolveTopicRef(html);
  const rawTitle = rawTitleOf(html);

  const body = firstPostBody(html);
  const lines = textLines(body);
  const magnets = collectMagnets(body);
  const torrents = collectTorrents(body);

  const headerLines = new Set<number>();
  for (const line of lines) if (blockHeaderText(line.text)) headerLines.add(line.offset);
  const { titleLangs, proseLangs } = topicAudioEvidence(html, lines, rawTitle, (line) =>
    headerLines.has(line.offset),
  );
  const topicAudioLangs = [...new Set([...titleLangs, ...proseLangs])];

  const variants: ParsedVariant[] = [];
  const usedHashes = new Set<string>();
  const usedTorrentUrls = new Set<string>();

  for (const line of lines) {
    const headerText = blockHeaderText(line.text);
    if (!headerText) continue;
    const header = parseBlockHeader(headerText);
    if (!header) continue;

    // A block is servable when it carries a magnet **or** a `.torrent` attachment: an indexer can
    // read the attachment, derive its infohash and synthesise the magnet. Dropping attachment-only
    // blocks (the old `if (!magnet) continue`) threw away every post whose uploader skipped the
    // magnet button, which is the shape `torrent-no-magnet.html` documents.
    const magnet = magnets.find((m) => m.pos > line.offset && !usedHashes.has(m.infohash));
    const torrent = torrents.find(
      (t) => t.pos > line.offset && (!magnet || t.pos < magnet.pos) && !usedTorrentUrls.has(t.url),
    );
    if (!magnet && !torrent) continue;
    if (magnet) usedHashes.add(magnet.infohash);
    if (torrent) usedTorrentUrls.add(torrent.url);

    variants.push({
      title: header.title,
      year: header.year,
      qualityLabel: [header.resolution, header.sourceTagRaw].filter(Boolean).join(' ') || null,
      resolution: header.resolution,
      sourceTagRaw: header.sourceTagRaw,
      codec: header.codec,
      audioCodecs: header.audioCodecs,
      audioLangs: header.audioLangs,
      sizeBytes: header.sizeBytes,
      // Null means "the hash must come from the attachment" — `persistTopic` refuses to write a
      // variant without one, because `variants.infohash` is NOT NULL and the feed keys on it.
      infohash: magnet?.infohash ?? null,
      magnet: magnet?.magnet ?? null,
      torrentUrl: torrent ? absoluteUrl(torrent.url, baseUrl) : null,
      topicAudioLangs,
      audioSourceCount:
        (header.audioLangs.length > 0 ? 1 : 0) +
        (titleLangs.length > 0 ? 1 : 0) +
        (proseLangs.length > 0 ? 1 : 0),
    });
  }

  // Some posts have no header at all: the only line carrying the quality is the torrent's own
  // filename (`www.1TamilMV.dev - The Naked Gun (2025) HQ HDRip - 720p … .torrent`). Those magnets
  // were dropped entirely. Attach any magnet no header claimed to the nearest such filename above
  // it — a second pass, so a block that has both a header and a filename still yields one variant.
  for (const magnet of magnets) {
    if (usedHashes.has(magnet.infohash)) continue;
    const filenameLine = [...lines]
      .filter((line) => line.offset < magnet.pos && /\.torrent\s*$/i.test(line.text))
      .sort((a, b) => b.offset - a.offset)[0];
    if (!filenameLine) continue;
    const stripped = stripMirrorPrefix(filenameLine.text.replace(/\.torrent\s*$/i, '').trim());
    const header = parseBlockHeader(stripped);
    if (!header) continue;
    usedHashes.add(magnet.infohash);
    variants.push({
      title: header.title,
      year: header.year,
      qualityLabel: [header.resolution, header.sourceTagRaw].filter(Boolean).join(' ') || null,
      resolution: header.resolution,
      sourceTagRaw: header.sourceTagRaw,
      codec: header.codec,
      audioCodecs: header.audioCodecs,
      audioLangs: header.audioLangs,
      sizeBytes: header.sizeBytes,
      infohash: magnet.infohash,
      magnet: magnet.magnet,
      torrentUrl: null,
      topicAudioLangs,
      audioSourceCount: header.audioLangs.length > 0 ? 1 : 0,
    });
    // The filename line is also the attachment's own label, so the URL comes from the block above.
    const attachment = torrents.find((t) => t.pos < magnet.pos && t.pos > filenameLine.offset - 1);
    if (attachment) variants[variants.length - 1]!.torrentUrl = absoluteUrl(attachment.url, baseUrl);
  }

  // A block header may omit its resolution. The summary line above the blocks usually lists
  // `[1080p & 720p - ... - 2.8GB - 1.4GB]`, so a size that appears there identifies the block.
  if (variants.some((variant) => variant.resolution === null)) {
    const summaryLine = lines.find(
      (line) => /\[[^\]]*\d{3,4}p[^\]]*\]/.test(line.text) && /\d+(?:\.\d+)?\s*(?:GB|MB)\b/i.test(line.text),
    );
    if (summaryLine) {
      const { bySize } = resolutionBySizeFromSummary(summaryLine.text);
      for (const variant of variants) {
        if (variant.resolution !== null) continue;
        const inferred = bySize.get(variant.sizeBytes);
        if (inferred) {
          variant.resolution = inferred;
          variant.qualityLabel = [inferred, variant.sourceTagRaw].filter(Boolean).join(' ');
        }
      }
    }
  }

  return {
    sourceTopicId: ref?.id ?? null,
    slug: ref?.slug ?? '',
    rawTitle,
    poster: posterOf(body, baseUrl),
    variants,
    links: linksOf(body),
  };
}
