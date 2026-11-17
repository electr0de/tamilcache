/**
 * Defensive reader for JSON-encoded array columns (`variants.audio_langs` and friends).
 *
 * `JSON.parse(...) as string[]` throws on corrupt or legacy values, and because it usually
 * runs inside a write transaction that turns a single bad row into a permanently stalled
 * replay. This helper never throws: anything unparseable degrades to an empty array.
 */
export function safeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
