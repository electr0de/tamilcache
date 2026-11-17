/**
 * IMDb ids are `tt` + 7 digits, but every client disagrees about the wire form: Radarr sends
 * `?imdbid=6478412`, Jackett emits `tt6478412`, and the torznab `imdb` attribute must be the bare
 * integer because Sonarr/Radarr `int.TryParse` it.
 *
 * One normaliser for all three, so a comparison can never be `tt…` against `…`.
 */
export function normaliseImdbId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim().replace(/^tt/i, '');
  if (!/^\d{5,9}$/.test(digits)) return null;
  if (digits === '0') return null;
  return `tt${digits.padStart(7, '0')}`;
}

/** The torznab `imdb` attribute value: `tt6478412` → `6478412`. */
export function imdbIdDigits(raw: string | null | undefined): number | null {
  const normalised = normaliseImdbId(raw);
  return normalised === null ? null : Number(normalised.slice(2));
}
