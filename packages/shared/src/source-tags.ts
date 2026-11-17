/**
 * Source tokens that Radarr's `QualityParser.SourceRegex` actually matches.
 *
 * Verified 2026-11-09 against `Radarr/develop src/NzbDrone.Core/Parser/QualityParser.cs`.
 * Anything outside this set makes Radarr report `Quality.Unknown`, and an unknown quality is
 * in no quality profile ⇒ the release is **never grabbed**, even when the name says `1080p`.
 *
 * The two traps this set encodes:
 *   - there is **no `HDRip` token**, so HDRip must be emitted as `WEBRip` (closest grabbable);
 *   - the group is spelled `PDVD`, so `PREDVD` does not match it.
 */
export const RADARR_SOURCE_ALLOWLIST: ReadonlySet<string> = new Set([
  'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'BDRip', 'BRRip', 'DVD9', 'DVD5', 'DVDR',
  // NOT 'TS': Radarr's alternative is `TS[-_. ]`, i.e. it needs a delimiter, so a bare
  // trailing `TS` token does not match. 'HDTS' and 'PDVD' do, and they cover every real case.
  'DVD', 'SCR', 'DVDSCR', 'HDTS', 'PDVD', 'TC', 'HDTC', 'CAM', 'HDCAM',
  'PDTV', 'SDTV', 'TVRip',
]);

export interface SourceTagMapping {
  /** A token from `RADARR_SOURCE_ALLOWLIST`, or null when nothing matched. */
  tag: string | null;
  /** `HQ Clean` / `HC` describe the audio, never the source. */
  cleanAudio: boolean;
  raw: string;
}

interface Rule {
  re: RegExp;
  tag: string;
}

/** Order matters: the more specific phrase must win (`HQ PreDVD` before any bare `DVD`). */
const RULES: readonly Rule[] = [
  { re: /hq\s*pre\s*-?\s*dvd|pre\s*-?\s*dvd/i, tag: 'PDVD' },
  // `HQ PRE-HD` is a pre-release HD, which Radarr has no token for; PDVD is the honest neighbour.
  { re: /hq\s*pre\s*-?\s*hd|pre\s*-?\s*hd/i, tag: 'PDVD' },
  { re: /\btv[\s-]?rip\b/i, tag: 'TVRip' },
  // The site prints `HQ HDRp` / `HDRb`; both mean HDRip, which Radarr has no token for either.
  { re: /hq\s*hdr[pb]\b|\bhdr[pb]\b/i, tag: 'WEBRip' },
  { re: /hq\s*hdts(?![-_. ]?rip)/i, tag: 'HDTS' },
  { re: /hdts/i, tag: 'HDTS' },
  { re: /hq\s*hdtc|hdtc[-\s]?rip|hd[-_. ]?tc/i, tag: 'HDTC' },
  { re: /true\s*web[-\s]?dl|nf\s*web[-\s]?dl|(?:amzn|dsnp|hmax|atvp)[-\s.]web[-\s.]dl|web[-\s]?dl/i, tag: 'WEB-DL' },
  // HDRip has NO token in Radarr. WEBRip is the closest grabbable equivalent and outranks
  // HDTV/DVD in the default profile ordering.
  { re: /hd[-\s]?rip/i, tag: 'WEBRip' },
  { re: /web[-\s]?rip/i, tag: 'WEBRip' },
  { re: /hd\s*tv[-\s]?rip|hdtv/i, tag: 'HDTV' },
  { re: /sd\s*tv[-\s]?rip|sdtv/i, tag: 'SDTV' },
  { re: /pdtv/i, tag: 'PDTV' },
  { re: /blu[-\s]?ray/i, tag: 'BluRay' },
  { re: /br[-\s]?rip/i, tag: 'BRRip' },
  { re: /bd[-\s]?rip/i, tag: 'BDRip' },
  { re: /dvd\s*9/i, tag: 'DVD9' },
  { re: /dvd\s*5/i, tag: 'DVD5' },
  { re: /dvdscr/i, tag: 'DVDSCR' },
  { re: /hd[-\s]?cam/i, tag: 'HDCAM' },
  { re: /\bcam\b/i, tag: 'CAM' },
  { re: /\bdvd\b/i, tag: 'DVD' },
];

export function mapSourceTag(raw: string): SourceTagMapping {
  const cleanAudio = /hq\s*clean|\bhc\b/i.test(raw);
  for (const rule of RULES) {
    if (!rule.re.test(raw)) continue;
    const tag = RADARR_SOURCE_ALLOWLIST.has(rule.tag) ? rule.tag : null;
    return { tag, cleanAudio, raw };
  }
  return { tag: null, cleanAudio, raw };
}
