export interface NormaliseInput {
  title: string;
  year: number | null;
  resolution: string | null;
  sourceTag: string | null;
  codec: string | null;
  audioCodecs: string | null;
  audioLangs: string[];
  sizeBytes: number;
  season?: number | null;
  epFrom?: number | null;
  epTo?: number | null;
  isPack?: boolean;
  dubbed?: boolean;
}

const GROUP = 'TMV';

const LANG_CASE: Record<string, string> = {
  hindi: 'Hindi',
  tamil: 'Tamil',
  telugu: 'Telugu',
  malayalam: 'Malayalam',
  kannada: 'Kannada',
  english: 'English',
};

const CODEC_CASE: Record<string, string> = {
  x264: 'x264',
  avc: 'x264',
  'h.264': 'x264',
  h264: 'x264',
  x265: 'x265',
  hevc: 'x265',
  'h.265': 'x265',
  h265: 'x265',
  'vc-1': 'VC-1',
  'mpeg-2': 'MPEG-2',
};

export function sizeLabel(bytes: number): string {
  if (bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10}GB`;
  return `${Math.round(bytes / 1024 ** 2)}MB`;
}

/** `AAC 2.0` → `AAC2.0`, `DD+5.1` → `DDP5.1`: Radarr/custom formats expect one token. */
export function audioCodecToken(raw: string): string {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  const map: Record<string, string> = {
    'DD+5.1': 'DDP5.1',
    'DD5.1': 'DD5.1',
    'DDP5.1': 'DDP5.1',
    'DD2.0': 'DD2.0',
    'AAC2.0': 'AAC2.0',
    'AAC5.1': 'AAC5.1',
    AAC: 'AAC',
    DTS: 'DTS',
    AC3: 'AC3',
    ATMOS: 'Atmos',
    MP3: 'MP3',
    OPUS: 'Opus',
    TRUEHD: 'TrueHD',
  };
  return map[compact] ?? sanitise(raw);
}

function sanitise(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[{}()]/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/** `v2`, `v3` are version markers, not part of the film name. */
function stripVersionMarkers(s: string): string {
  return s.replace(/\.?v\d+(?=\.|$)/gi, '');
}

export function normaliseTitle(input: NormaliseInput): string {
  const parts: string[] = [stripVersionMarkers(sanitise(input.title))];
  if (input.year) parts.push(String(input.year));

  if (input.season) {
    const season = `S${String(input.season).padStart(2, '0')}`;
    if (input.isPack && input.epFrom && input.epTo) {
      parts.push(`${season}E${String(input.epFrom).padStart(2, '0')}-E${String(input.epTo).padStart(2, '0')}`);
    } else if (input.epFrom) {
      parts.push(`${season}E${String(input.epFrom).padStart(2, '0')}`);
    } else {
      parts.push(season);
    }
  }

  // Resolution must stay adjacent to source: Radarr resolves `TeleSync720p` vs `WEBDL1080p`
  // from that pair, and defaults to 480p when the resolution is missing.
  if (input.resolution) parts.push(input.resolution);
  if (input.sourceTag) parts.push(input.sourceTag);
  if (input.codec) parts.push(CODEC_CASE[input.codec.toLowerCase()] ?? sanitise(input.codec));
  if (input.audioCodecs) parts.push(audioCodecToken(input.audioCodecs).replace(/^\.+|\.+$/g, ''));

  const langs = [...new Set(input.audioLangs.map((l) => l.toLowerCase()))].filter((l) => LANG_CASE[l]);
  if (langs.length > 0) {
    // One token per language: `TamilEnglish` would match neither `Tamil` nor `English` in a
    // client's language detection, so they must stay dot-separated.
    parts.push(langs.map((l) => LANG_CASE[l]).join('.'));
    if (input.dubbed) parts.push('HindiDubbed');
  }

  const size = sizeLabel(input.sizeBytes);
  if (size) parts.push(size);

  return `${parts.filter((p) => p.length > 0).join('.')}-${GROUP}`;
}
