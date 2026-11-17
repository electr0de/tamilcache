export interface CategoryRange {
  from: number;
  to: number;
}

/**
 * Newznab treats `cat` as a union and a parent id covers its subtree (`2000` ⇒ all movies).
 * Prowlarr sends `2000,5000`; parsing that with `Number()` produced `NaN`, which silently
 * dropped the filter — the search looked correct while ignoring the client's request.
 */
export function parseCategories(raw: string | string[] | undefined): CategoryRange[] | null {
  if (raw === undefined) return null;

  const values = Array.isArray(raw) ? raw : [raw];
  const ids = values
    .flatMap((value) => value.split(','))
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  const ranges = new Map<number, CategoryRange>();
  for (const id of ids) {
    const range = id % 1000 === 0 ? { from: id, to: id + 999 } : { from: id, to: id };
    ranges.set(range.from, range);
  }
  return ranges.size > 0 ? [...ranges.values()] : null;
}
