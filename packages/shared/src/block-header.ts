/**
 * Parsing of one TamilMV "quality block" header line.
 *
 * A block header looks like
 *
 *   Jailer 2 (2026) Tamil HQ HDRip - 1080p - x264 - (AAC 2.0) - 2.8GB - HC- ESub :
 *
 * and is anchored by its *trailing colon* — see `isBlockHeaderLine` and the
 * "THE PARSING RULE THIS SET PROVES" section of `test/fixtures/MANIFEST.md`.
 * The topic-level summary line carries a size and a source tag too, so a header is never
 * selected on "contains a size and a source tag" alone.
 */

export interface BlockHeader {
  /** Raw title fragment of the block line. Normalisation happens in a later stage. */
  title: string;
  year: number | null;
  audioLangs: string[];
  /** Source tag exactly as printed (`HQ HDRip`, `TRUE WEB-DL`, `BR-Rip`, …). */
  sourceTagRaw: string;
  resolution: string | null;
  codec: string | null;
  audioCodecs: string | null;
  sizeBytes: number;
}

const SIZE = /(\d+(?:\.\d+)?)\s*(GB|MB|KB)\b/i;
const RESOLUTION = /\b(2160p|1440p|1080p|720p|576p|480p|360p|4K)\b/i;

/**
 * Source tags as printed on the site. Ordered longest/most specific first, because the
 * earliest *position* wins: `HQ HDRip` must not degrade to `HDRip`, and `HDTC-Rip` must
 * win over nothing else in the line.
 *
 * Deliberately absent — the manifest calls these out as non-sources:
 * `HQ Clean`, `HC`, `UNTOUCHED`. `HDRip` is here because the site prints it, but Radarr has
 * no `HDRip` token; mapping it to a grabbable token is `mapSourceTag`'s job (Task 3.1).
 */
// `HQ PRE-HD`, `TVRip` and the `HQ HDRp` typo are printed by the site and were absent from this
// table, so every block carrying them was dropped without a trace (measured 2026-11-17).
const SOURCE =
  /\b(HQ\s+HDTS|HDTS|HQ\s*HDTC[-\s]?Rip|HDTC[-\s]?Rip|HQ\s+PreDVD|PreDVD|HQ\s+PRE[-\s]?HD|PRE[-\s]?HD|TVRip|HQ\s+HDR[pb]|HDR[pb]|HQ\s+HDRip|HDRip|TRUE\s+WEB[-\s]?DL|NF\s+WEB[-\s]?DL|WEB[-\s]?DL|HDTV[-\s]?Rip|SDTV[-\s]?Rip|PDTV|HDTV|SDTV|Blu[-\s]?Ray|BR[-\s]?Rip|BD[-\s]?Rip|DVD\s?9|DVD\s?5|HDCAM|CAM|DVDSCR|DVDRip)\b/i;

/** Encoder/standard token, normalised to the spelling Radarr's parser recognises. */
const CODEC_X265 = /\b(?:x265|h\.?\s?265|HEVC)\b/i;
const CODEC_X264 = /\b(?:x264|h\.?\s?264|AVC)\b/i;
const CODEC_OTHER = /\b(VC-?1|MPEG-?2|XviD|DivX)\b/i;

const AUDIO_CODEC =
  /\b(DD\+?\s?5\.1|DDP\s?5\.1|DD\+?\s?2\.0|DD\s?5\.1|DD\s?2\.0|AAC(?:\s?5\.1|\s?2\.0)?|DTS(?:[-\s]?HD)?|EAC3|AC3|Atmos|MP3|Opus|TrueHD|FLAC)\b/i;

/**
 * Language tokens, longest first so `Tamil` never matches as `tam`. The one- and
 * two-letter forms are the abbreviations the *attachment file names* use (`Tam`, `Hin`);
 * the header is preferred, but both must land on the same canonical language.
 */
const LANG = /\b(hindi|hind|hin|tamil|tam|telugu|tel|malayalam|mal|kannada|kan|english|eng)\b/gi;

const LANG_ALIASES: Record<string, string> = {
  hindi: 'hindi',
  hind: 'hindi',
  hin: 'hindi',
  tamil: 'tamil',
  tam: 'tamil',
  telugu: 'telugu',
  tel: 'telugu',
  malayalam: 'malayalam',
  mal: 'malayalam',
  kannada: 'kannada',
  kan: 'kannada',
  english: 'english',
  eng: 'english',
};

/** `700MB` → bytes. Returns 0 when the text carries no size. */
export function parseSize(text: string): number {
  const m = SIZE.exec(text);
  if (!m?.[1] || !m[2]) return 0;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const multiplier = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
  return Math.round(n * multiplier);
}

/**
 * Canonical audio languages named in a piece of text, document order, deduped.
 *
 * `Original Audio` / `Org Auds` carry no language token, so they contribute nothing —
 * they must never invent one. `HQ Clean`, `HC` and `UNTOUCHED` are not languages either.
 */
export function parseAudioLangs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(LANG)) {
    const token = m[1]?.toLowerCase();
    if (!token) continue;
    const canonical = LANG_ALIASES[token];
    if (canonical) out.add(canonical);
  }
  return [...out];
}

/**
 * `Jailer 2 Tamil` → `Jailer 2`. The language already lives in `audioLangs`, so a trailing
 * language run on the title fragment is noise. Only the tail is stripped, so a title that
 * *starts* with a language word (`Hindi Medium`) survives.
 */
function stripTrailingLanguages(title: string): string {
  const word = '(?:hindi|tamil|telugu|malayalam|kannada|english)';
  const trailing = new RegExp(`\\s+${word}(?:\\s*[+/]\\s*${word})*$`, 'i');
  let out = title;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(trailing, '').trim();
  }
  return out;
}

function parseCodec(beforeSize: string): string | null {
  if (CODEC_X265.test(beforeSize)) return 'x265';
  if (CODEC_X264.test(beforeSize)) return 'x264';
  const other = CODEC_OTHER.exec(beforeSize)?.[1];
  return other ? other.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null;
}

/**
 * Parses a block header line. Returns null when the line is not a block header, i.e. it has
 * no size or no source tag.
 *
 * A **missing resolution is valid** — the site ships `… - x264 - HQ Clean Audio - AAC - 400MB :`
 * blocks with no resolution at all (single-quality.html, block 2).
 */
/**
 * The token right after the title's year — where the site always prints the source
 * (`Title (2026) HQ XYZ-Rip - 1080p …`). Empty when there is no year to anchor on.
 */
function guessSourceToken(beforeSize: string): string {
  const head = beforeSize.split(/\s+-\s+/)[0] ?? '';
  const match = /^.*?\(\d{4}\)\s*(.+)$/.exec(head);
  const candidate = (match?.[1] ?? '').trim();
  // A bare resolution or codec in that slot is not a source.
  if (candidate === '' || RESOLUTION.test(candidate) || CODEC_X264.test(candidate) || CODEC_X265.test(candidate)) {
    return '';
  }
  return candidate;
}

export function parseBlockHeader(raw: string): BlockHeader | null {
  const sizeMatch = SIZE.exec(raw);
  const sizeBytes = parseSize(raw);
  if (!sizeMatch || !sizeBytes) return null;

  const beforeSize = raw.slice(0, sizeMatch.index);
  const resolution = RESOLUTION.exec(beforeSize)?.[1]?.toLowerCase() ?? null;
  const src = SOURCE.exec(beforeSize)?.[1];
  // Shape, not vocabulary: a block that names a year and a resolution but whose source we do not
  // recognise used to be dropped along with its magnet, silently. Keep it: `mapSourceTag` turns the
  // token into `UNKNOWN_SOURCE`, which lands in the review queue where a new spelling is visible.
  // Deliberately *not* applied to a header with no resolution — that shape is legitimate and its
  // resolution is inferred from the summary line, so a guess there could invent the wrong block.
  const guessed = src === undefined && resolution !== null && /\(\d{4}\)/.test(beforeSize)
    ? guessSourceToken(beforeSize)
    : '';
  const sourceTagRaw = (src ?? guessed).replace(/\s+/g, ' ').trim();
  if (sourceTagRaw === '') return null;
  const titlePart = beforeSize.split(/\s+-\s+/)[0] ?? beforeSize;
  const year = /\((\d{4})\)/.exec(beforeSize)?.[1];
  const title = stripTrailingLanguages(
    titlePart
      .replace(/\(\d{4}\)/, '')
      .replace(SOURCE, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  const audioCodecs = AUDIO_CODEC.exec(beforeSize)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;

  return {
    title,
    year: year ? Number(year) : null,
    audioLangs: parseAudioLangs(beforeSize),
    sourceTagRaw,
    resolution: resolution === '4k' ? '2160p' : resolution,
    codec: parseCodec(beforeSize),
    audioCodecs,
    sizeBytes,
  };
}

/**
 * A colour, a colon, then optionally the upload date: daily shows print
 * `… - 1080p - AVC - AAC - 1.7GB : [10-11-2026]`. The bracketed tail is part of the anchor, not
 * of the header, so it must be allowed — without it every BIGG BOSS / serial page (198 blocks on
 * one topic) parsed to zero variants and dead-lettered.
 */
/**
 * A block header ends in one of a few ways, and the colon is only the commonest:
 *
 *   … - 6.2GB :                    the documented shape
 *   … - 6.2GB - ESub               uploaders who skip the colon (4 of 14 sampled parse_failed topics)
 * (A line that ends with `.torrent` is handled by the parser, not here: counting it as a header
 * would give one block two headers.)
 */
const HEADER_TAIL = /(?:\s*:\s*(?:\[[^\]\n]{1,40}\]\s*)?|\s*[-–]?\s*e-?subs?(?:\.mkv)?\s*)$/i;
/** `[4K, 1080p & 720p …]` is the topic summary, never a block: it lists several releases at once. */
// Two resolution tokens inside one bracket is a summary of several releases, however they
// are separated (`[4K, 1080p & 720p]`, `[1080p - 720p - AVC ...]`). A real block names one.
const MULTI_RESOLUTION = /\[[^\]\n]*\b(?:2160p|1440p|1080p|720p|480p|4k)\b[^\]\n]*\b(?:2160p|1440p|1080p|720p|480p|4k)\b[^\]\n]*\]/i;
/** `www.1TamilMV.dev - ` on a torrent filename line is the mirror, not the film. */
const MIRROR_PREFIX = /^\s*(?:www\.)?[a-z0-9.-]*tamilmv[a-z0-9.]*\s*-\s*/i;

/** `www.1TamilMV.dev - The Naked Gun (2025) …` → `The Naked Gun (2025) …`. */
export function stripMirrorPrefix(text: string): string {
  return text.replace(MIRROR_PREFIX, '').trim();
}

/** The header text with the anchor colon (and any dated tail) removed, or null when not a header. */
export function blockHeaderText(line: string): string | null {
  const trimmed = line.trim();
  // Checked before the terminator: the summary line also carries a size and a source tag.
  if (MULTI_RESOLUTION.test(trimmed)) return null;
  let stripped = trimmed;
  for (let pass = 0; pass < 2; pass++) {
    const next = stripped.replace(HEADER_TAIL, '').trim();
    if (next === stripped) break;
    stripped = next;
  }
  if (stripped === trimmed) return null;
  stripped = stripped.replace(MIRROR_PREFIX, '').trim();
  return parseBlockHeader(stripped) === null ? null : stripped;
}

/**
 * THE ANCHOR RULE. A block header is a line that carries a size and a source tag and is
 * terminated by `:` (optionally followed by a bracketed date). Measured across every
 * magnet-bearing fixture, the number of such lines equals the number of magnets exactly; the
 * topic-level summary line (same size, same source tag, no trailing colon) is rejected.
 */
export function isBlockHeaderLine(line: string): boolean {
  return blockHeaderText(line) !== null;
}
