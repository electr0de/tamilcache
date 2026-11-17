/**
 * Higher is better. Used for frontend ordering, feed tiebreaks and BEST_VARIANT_ONLY.
 *
 * This is NOT how Radarr decides: Radarr ranks by its own quality profile, and our only lever
 * over that is emitting the correct source token + resolution pair. This score exists so *we*
 * can show one canonical "best" variant and order results sensibly.
 */
const RES_SCORE: Record<string, number> = {
  '2160p': 50,
  '1440p': 45,
  '1080p': 40,
  '720p': 30,
  '576p': 20,
  '480p': 15,
  '360p': 10,
};

const SOURCE_SCORE: Record<string, number> = {
  BluRay: 100,
  'WEB-DL': 90,
  WEBRip: 80,
  BDRip: 75,
  BRRip: 70,
  HDTV: 60,
  DVD9: 55,
  DVD5: 50,
  DVDR: 50,
  DVD: 50,
  PDTV: 40,
  SDTV: 35,
  HDTC: 30,
  HDTS: 20,
  PDVD: 18,
  TC: 15,
  TS: 12,
  HDCAM: 6,
  CAM: 5,
};

export function qualityRank(resolution: string | null, sourceTag: string | null): number {
  const res = resolution ? (RES_SCORE[resolution] ?? 0) : 0;
  const source = sourceTag ? (SOURCE_SCORE[sourceTag] ?? 0) : 0;
  return res * 100 + source;
}
