import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseTopicPage } from '../src/topic-parser.js';
import { mapSourceTag, RADARR_SOURCE_ALLOWLIST } from '../src/source-tags.js';
import { normaliseTitle } from '../src/normalise-title.js';

/**
 * Verbatim copies of Radarr's QualityParser regexes
 * (Radarr/develop src/NzbDrone.Core/Parser/QualityParser.cs, fetched 2026-11-09).
 *
 * One adaptation: the original `webdl` group contains `[. ](?-i:WEB)$`, which is .NET inline
 * flag syntax with no JS equivalent. It is dropped; the remaining alternatives still match the
 * `WEB` forms we could ever emit (we always emit `WEB-DL`, never a bare `WEB`).
 * A comment in `normalise-title.ts` keeps it that way.
 */
const SOURCE = /\b(?:(?<bluray>M?Blu[-_. ]?Ray|HD[-_. ]?DVD|BD(?!$)|UHD2?BD|BDISO|BDMux|BD25|BD50|BR[-_. ]?DISK)|(?<webdl>WEB[-_. ]?DL(?:mux)?|AmazonHD|AmazonSD|iTunesHD|MaxdomeHD|NetflixU?HD|WebHD|HBOMaxHD|DisneyHD|[. ]WEB[. ](?:[xh][ .]?26[45]|AVC|HEVC|DDP?5[. ]1)|(?:\d{3,4}0p)[-. ](?:Hybrid[-_. ]?)?WEB[-. ]|[-. ]WEB[-. ]\d{3,4}0p|\b\s\/\sWEB\s\/\s\b|(?:AMZN|NF|DP)[. -]WEB[. -](?!Rip))|(?<webrip>WebRip|Web-Rip|WEBMux)|(?<hdtv>HDTV)|(?<bdrip>BDRip|BDLight|HD[-_. ]?DVDRip|UHDBDRip)|(?<brrip>BRRip)|(?<dvdr>\d?x?M?DVD-?[R59])|(?<dvd>DVD(?!-R)|DVDRip|xvidvd)|(?<regional>R[0-9]{1}|REGIONAL)|(?<scr>SCR|SCREENER|DVDSCR|DVDSCREENER)|(?<ts>TS[-_. ]|TELESYNCH?|HD-TS|HDTS|PDVD|TSRip|HDTSRip)|(?<tc>TC|TELECINE|HD-TC|HDTC)|(?<cam>CAMRIP|(?:NEW)?CAM|HD-?CAM(?:Rip)?|HQCAM)|(?<wp>WORKPRINT|WP)|(?<pdtv>PDTV)|(?<sdtv>SDTV)|(?<tvrip>TVRip))(?:\b|$|[ .])/i;

const RESOLUTION = /\b(?:(?<R360p>360p)|(?<R480p>480p|480i|640x480|848x480)|(?<R540p>540p)|(?<R576p>576p)|(?<R720p>720p|1280x720|960p)|(?<R1080p>1080p|1920x1080|1440p|FHD|1080i|4kto1080p)|(?<R2160p>2160p|3840x2160|4k[-_. ](?:UHD|HEVC|BD|H\.?265)|(?:UHD|HEVC|BD|H\.?265)[-_. ]4k))\b/i;

const SOURCE_GROUP_TO_NAME: Record<string, string> = {
  bluray: 'Bluray',
  webdl: 'WEBDL',
  webrip: 'WEBRip',
  hdtv: 'HDTV',
  bdrip: 'BRRip',
  brrip: 'BRRip',
  dvdr: 'DVDR',
  dvd: 'DVD',
  regional: 'REGIONAL',
  scr: 'DVDSCR',
  ts: 'TeleSync',
  tc: 'TeleCine',
  cam: 'CAM',
  pdtv: 'HDTV',
  sdtv: 'SDTV',
  tvrip: 'HDTV',
};

const RES_GROUP_TO_NAME: Record<string, string> = {
  R360p: '360p',
  R480p: '480p',
  R540p: '540p',
  R576p: '576p',
  R720p: '720p',
  R1080p: '1080p',
  R2160p: '2160p',
};

export function radarrQuality(name: string): string {
  const source = SOURCE.exec(name);
  const res = RESOLUTION.exec(name);
  if (!source?.groups) return 'Unknown';
  // Radarr keeps the source quality even when the resolution is absent: `ts` yields
  // `TELESYNC` with Resolution = 0, `webdl` falls back to WEBDL480p. So a missing resolution
  // is a *degraded* result, not an ungrabbable one — the test tracks them separately.
  const sourceGroup = Object.keys(source.groups).find((k) => source.groups?.[k] !== undefined);
  if (!sourceGroup) return 'Unknown';
  if (!res?.groups) return `${SOURCE_GROUP_TO_NAME[sourceGroup] ?? 'Unknown'}(nores)`;
  const resGroup = Object.keys(res.groups).find((k) => res.groups?.[k] !== undefined);
  const base = SOURCE_GROUP_TO_NAME[sourceGroup] ?? 'Unknown';
  const resName = resGroup ? (RES_GROUP_TO_NAME[resGroup] ?? '') : '';
  return `${base}${resName}`;
}

describe('Radarr compatibility of emitted tokens', () => {
  it('every allowlisted token is recognised by Radarr', () => {
    for (const token of RADARR_SOURCE_ALLOWLIST) {
      expect(SOURCE.test(token), `${token} is in our allowlist but Radarr cannot parse it`).toBe(true);
    }
  });

  it('Radarr cannot parse HDRip or PREDVD — the reason the mapping exists', () => {
    expect(SOURCE.test('Movie.2025.1080p.HDRip.x264-GRP')).toBe(false);
    expect(SOURCE.test('Movie.2025.1080p.PREDVD.x264-GRP')).toBe(false);
  });

  it('maps HDRip to a token Radarr does parse', () => {
    const tag = mapSourceTag('HQ HDRip').tag;
    expect(tag).toBe('WEBRip');
    expect(SOURCE.test(`Movie.2025.1080p.${tag}.x264-GRP`)).toBe(true);
  });
});

describe('fixture variants compose into qualities Radarr understands', () => {
  const dir = join(import.meta.dirname, 'fixtures');
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));

  const rows: Array<{ file: string; raw: string; tag: string | null; res: string | null; name: string; quality: string }> = [];

  for (const file of files) {
    const html = readFileSync(join(dir, file), 'utf8');
    const topic = parseTopicPage(html, 'https://www.1tamilmv.io');
    for (const variant of topic.variants) {
      const mapping = mapSourceTag(variant.sourceTagRaw);
      const name = mapping.tag
        ? normaliseTitle({
            title: topic.slug.replace(/-\d{4}-.*$/, '').replace(/-/g, ' ') || topic.rawTitle,
            year: Number(/(?:^|-)((?:19|20)\d{2})(?:-|$)/.exec(topic.slug)?.[1] ?? 0) || null,
            resolution: variant.resolution,
            sourceTag: mapping.tag,
            codec: variant.codec,
            audioCodecs: variant.audioCodecs,
            audioLangs: variant.audioLangs,
            sizeBytes: variant.sizeBytes,
          })
        : '';
      rows.push({
        file,
        raw: variant.sourceTagRaw,
        tag: mapping.tag,
        res: variant.resolution,
        name,
        quality: name ? radarrQuality(name) : 'Unknown',
      });
    }
  }

  it('parses at least 40 fixture variants', () => {
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });

  it('resolves every variant with a known source to a non-Unknown Radarr quality', () => {
    const unresolved = rows.filter((r) => r.tag !== null && r.quality === 'Unknown');
    expect(
      unresolved,
      `these would never be grabbed by Radarr:\n${unresolved.map((r) => `${r.file} ${r.raw} -> ${r.name}`).join('\n')}`,
    ).toEqual([]);
  });

  it('refuses to synthesise a name when the source is unknown', () => {
    const known = rows.filter((r) => r.tag !== null);
    const unknownSource = rows.filter((r) => r.tag === null);
    expect(known.every((r) => r.name.length > 0)).toBe(true);
    expect(unknownSource.every((r) => r.name === '')).toBe(true);
  });

  it('keeps the unknown-source share under 10% of fixture variants', () => {
    const unknown = rows.filter((r) => r.tag === null).length;
    expect(unknown / rows.length).toBeLessThan(0.1);
  });

  it('always resolves a resolution when the variant has one', () => {
    for (const row of rows.filter((r) => r.res !== null && r.tag !== null)) {
      expect(RESOLUTION.test(row.name), `${row.name} lost its resolution`).toBe(true);
    }
  });

  it('reports (but permits) variants whose block header omitted a resolution', () => {
    const noRes = rows.filter((r) => r.res === null && r.tag !== null);
    // Measured 2026-11-09: 10 of 29 fixture variants. They are all the "Rips" tier — the
    // `[x264 - 700MB - 400MB & 250MB]` blocks, which state a size but never a resolution, even
    // in the magnet's `dn`. Radarr falls back to WEBRip480p / TeleSync(0) for them, which is
    // roughly what those rips actually are, so they stay grabbable and rank at the bottom.
    // Asserted as a ceiling so a parser regression that starts dropping resolutions is caught.
    expect(noRes.length / rows.length).toBeLessThan(0.4);
  });
});
