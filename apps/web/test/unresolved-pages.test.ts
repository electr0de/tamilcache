import { readFileSync } from 'node:fs';
import { sectionsOf } from '../src/pages/Coverage.js';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(import.meta.dirname, '..', path), 'utf8');

/**
 * Source-level assertions for the three new screens. Their real verification is the browser pass
 * in the phase gate; what must not silently regress is the wiring that makes them reachable and
 * the two actions each exists for.
 */
describe('unresolved screens', () => {
  it('registers the routes and the nav entries', () => {
    const app = read('src/App.tsx');
    for (const route of ['/unresolved', '/dead', '/coverage']) expect(app).toContain(`to: '${route}'`);
    for (const route of ['/unresolved', '/dead', '/coverage']) expect(app).toContain(`path="${route}"`);
  });

  it('offers both a magnet form and a link-out for a gated post', () => {
    const page = read('src/pages/Unresolved.tsx');
    expect(page).toContain('submitMagnet');
    expect(page).toContain('rel="noreferrer noopener"');
    expect(page).toContain("magnet:?xt=urn:btih:");
  });

  it('asks for the resolution and size the feed needs to rank a pasted magnet', () => {
    const page = read('src/pages/Unresolved.tsx');
    expect(page).toContain('sizeBytes: Math.round(Number(sizeGb) * 1024 ** 3)');
    expect(page).toContain('resolution');
  });

  it('lists only gone topics as dead and offers a recheck', () => {
    // Dead links is now the gone view of the shared table, so the assertion follows the delegation
    // and checks that the recheck action exists where the rows are rendered.
    expect(read('src/pages/DeadLinks.tsx')).toContain('fixedStatus="gone"');
    expect(read('src/pages/Unresolved.tsx')).toContain('api.recheck');
  });

  it('reads the audit instead of running it in a request', () => {
    const page = read('src/pages/Coverage.tsx');
    expect(page).toContain('api.coverage()');
    expect(page).toContain('pnpm coverage:audit');
  });

  it('groups by the hub and shows the site title, not the slug', () => {
    const page = read('src/pages/Coverage.tsx');
    expect(page).toContain('board.hub?.title');
    expect(page).toContain('{board.title}');
    expect(page).toContain('<details');
  });
});

describe('unresolved work queue', () => {
  it('shows all four states by default, tagged per row', () => {
    const page = read('src/pages/Unresolved.tsx');
    expect(page).toContain("fixedStatus ?? 'all'");
    for (const label of ["'gated'", "'nothing linked'", "'parser missed'", "'gone'"]) {
      expect(page).toContain(label);
    }
  });

  it('has search, a board filter, a status filter and paging with a total', () => {
    const page = read('src/pages/Unresolved.tsx');
    expect(page).toContain('aria-label="search unresolved"');
    expect(page).toContain('aria-label="board filter"');
    expect(page).toContain('aria-label="status filter"');
    expect(page).toContain('api.unresolved(');
    expect(page).toContain('of {total.toLocaleString()}');
  });

  it('offers resolve only on a gated row, recheck only where a retry can help', () => {
    const page = read('src/pages/Unresolved.tsx');
    expect(page).toContain("row.status === 'external'");
    expect(page).toContain("row.status === 'gone' || row.status === 'parse_failed'");
  });

  it('dead links is the gone view of the same table', () => {
    expect(read('src/pages/DeadLinks.tsx')).toContain('fixedStatus="gone"');
  });
});

describe('coverage grouping', () => {
  const board = (id: number, hubTitle: string) => ({
    id,
    title: `board ${id}`,
    hub: { title: hubTitle },   // language sections have no forum id — the id was never real
    name: `board-${id}`,
    scope: 'include' as const,
    pagesOnSite: 10,
    pagesCovered: 10,
    slots: 250,
    fetched: 250,
    stored: 100,
    byStatus: { parsed: 100 },
  });

  it('groups by the section title even when the hub carries no id', () => {
    // Regression: grouping by hub.id collapsed all 86 boards into the first section (Tamil).
    const sections = sectionsOf({ boards: [board(10, 'Tamil'), board(23, 'Telugu'), board(57, 'Hindi')], problems: [], exitCode: 0 });

    expect(sections.map((section) => section.hubTitle)).toEqual(['Tamil', 'Telugu', 'Hindi']);
    expect(sections.map((section) => section.included.length)).toEqual([1, 1, 1]);
  });

  it('keeps a board in one section only', () => {
    const sections = sectionsOf({
      boards: [board(10, 'Tamil'), board(11, 'Tamil'), board(23, 'Telugu')],
      problems: [],
      exitCode: 0,
    });
    expect(sections.find((section) => section.hubTitle === 'Tamil')?.included).toHaveLength(2);
    expect(sections.find((section) => section.hubTitle === 'Telugu')?.included).toHaveLength(1);
  });
});
