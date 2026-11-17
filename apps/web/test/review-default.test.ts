import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, '../src/pages/Review.tsx'), 'utf8');

/**
 * A source-level assertion, deliberately: the review page is a screen whose entire behaviour here
 * is one default. A full render needs the whole provider stack, and the behaviour under test is
 * "the checkbox starts unchecked", which a grep states exactly.
 *
 * Why it matters: `applyToSimilar` sends `{ forumIds }` with no content constraint. Defaulting to
 * true meant one click taught a board-wide rule; five such rules existed, one of which stamped 881
 * variants hindi_original and three of which deleted every variant on their board.
 */
describe('Review page rule default', () => {
  it('starts with "teach every row from these forums" switched off', () => {
    expect(source).toMatch(/const \[applyToSimilar, setApplyToSimilar\] = useState\(false\)/);
  });

  it('labels the checkbox so the blast radius is explicit', () => {
    expect(source).toContain('teach every row from these forums');
  });
});
