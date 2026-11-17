/** FTS5 refuses tokens shorter than three characters, so short fragments stay on `LIKE`. */
const MIN_FTS_LENGTH = 3;

/**
 * Quote every term and add a prefix star.
 *
 * Unquoted input is parsed as FTS5 syntax: `a AND b`, a stray `"`, or `-term` either changes the
 * meaning of the query or makes SQLite throw a syntax error (which would surface as a 500 on a
 * user's search box). Quoting makes the input inert; splitting on non-alphanumerics handles the
 * dotted `normTitle` shape and hyphenated titles.
 */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= MIN_FTS_LENGTH);

  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(' ');
}

export function shouldUseFts(input: string): boolean {
  return toFtsQuery(input) !== null;
}
