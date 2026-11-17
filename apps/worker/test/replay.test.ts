import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, media, overrides, rules, sources, topics, variants } from '@tamilcache/db/schema';
import { evidenceHash } from '@tamilcache/shared';
import { eq } from 'drizzle-orm';
import { previewRule, replayAll } from '../src/replay.js';

let db: Db;

let seededParents = false;
let seedCounter = 0;

function seed(
  opts: {
    audioLangs?: string[];
    topicAudioLangs?: string[];
    audioSourceCount?: number;
    originalLanguage?: string | null;
    poster?: string | null;
  } = {},
) {
  if (!seededParents) {
    db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
    db.insert(forums).values({ sourceId: 1, sourceForumId: 22, name: 'Telugu', inScope: true }).run();
    seededParents = true;
  }
  seedCounter += 1;
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId: seedCounter,
      slug: 'x-2026-telugu-hq-clean',
      rawTitle: 'X (2026) Telugu HQ Clean',
      poster: opts.poster ?? null,
      kind: 'movie',
    })
    .returning()
    .get();

  let mediaId: number | null = null;
  if (opts.originalLanguage) {
    const m = db
      .insert(media)
      .values({ tmdbId: 42, type: 'movie', title: 'X', originalLanguage: opts.originalLanguage })
      .returning()
      .get();
    mediaId = m.id;
  }

  db.insert(variants)
    .values({
      topicId: topic.id,
      sourceTagRaw: 'HQ HDRip',
      sourceTag: 'WEBRip',
      audioLangs: opts.audioLangs ?? [],
      topicAudioLangs: opts.topicAudioLangs ?? [],
      audioSourceCount: opts.audioSourceCount ?? 0,
      sizeBytes: 1,
      infohash: 'a'.repeat(40),
      mediaId,
      decision: 'unknown',
      reviewReason: 'NO_AUDIO_TAG',
    })
    .run();
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  seededParents = false;
  seedCounter = 0;
});

describe('replayAll', () => {
  it('applies a new rule to unknown rows and is idempotent', () => {
    seed();
    db.insert(rules)
      .values({ priority: 10, action: 'hindi_dubbed', predicate: JSON.stringify({ forumIds: [1] }) })
      .run();

    const first = replayAll(db);
    const second = replayAll(db);

    expect(first.updated).toBe(1);
    expect(second.updated).toBe(0);
    const row = db.select().from(variants).all()[0];
    expect(row?.decision).toBe('hindi_dubbed');
    expect(row?.decisionSource).toBe('rule');
    expect(row?.classifierVersion).toBe(1);
  });

  it('never overwrites a manual override', () => {
    seed();
    const row = db.select().from(variants).all()[0]!;
    const hash = evidenceHash({
      forumId: 1,
      forumName: 'Telugu',
      slug: 'x-2026-telugu-hq-clean',
      rawTitle: 'X (2026) Telugu HQ Clean',
      poster: null,
      sourceTagRaw: 'HQ HDRip',
      resolution: null,
      audioLangs: [],
    });
    db.insert(overrides).values({ evidenceHash: hash, action: 'not_hindi' }).run();
    db.insert(rules)
      .values({ priority: 1, action: 'hindi_dubbed', predicate: JSON.stringify({ forumIds: [1] }) })
      .run();

    replayAll(db);
    expect(db.select().from(variants).all()[0]?.decision).toBe('not_hindi');
    expect(row.id).toBeGreaterThan(0);
  });

  it('uses the provider original language for Hindi-original films', () => {
    seed({ originalLanguage: 'hi' });
    replayAll(db);
    const row = db.select().from(variants).all()[0];
    expect(row?.decision).toBe('hindi_original');
    expect(row?.decisionSource).toBe('provider');
  });

  it('classifies Hindi audio as dubbed without a provider', () => {
    seed({ audioLangs: ['hindi', 'telugu'] });
    replayAll(db);
    expect(db.select().from(variants).all()[0]?.decision).toBe('hindi_dubbed');
  });

  it('decides not_hindi from two agreeing places with no provider at all', () => {
    // The shape that used to sit in the review queue forever: title and header both say Tamil.
    seed({ audioLangs: ['tamil'], topicAudioLangs: ['tamil'], audioSourceCount: 2 });
    replayAll(db);
    const row = db.select().from(variants).all()[0];
    expect(row?.decision).toBe('not_hindi');
    expect(row?.decisionSource).toBe('auto');
    expect(row?.reviewReason).toBeNull();
  });

  it('keeps a single-place row in review rather than guessing', () => {
    seed({ audioLangs: ['tamil'], audioSourceCount: 1 });
    replayAll(db);
    const row = db.select().from(variants).all()[0];
    expect(row?.decision).toBe('unknown');
    expect(row?.reviewReason).toBe('NO_PROVIDER_MATCH');
  });

  it('prefers Hindi named by a topic-level place over agreement elsewhere', () => {
    seed({ audioLangs: ['tamil'], topicAudioLangs: ['tamil', 'hindi'], audioSourceCount: 2 });
    replayAll(db);
    expect(db.select().from(variants).all()[0]?.decision).toBe('hindi_dubbed');
  });

  it('classifies non-Hindi audio as not_hindi when the provider agrees', () => {
    seed({ audioLangs: ['telugu'], originalLanguage: 'te' });
    replayAll(db);
    expect(db.select().from(variants).all()[0]?.decision).toBe('not_hindi');
  });

  it('leaves unclassifiable rows in the review queue with a reason', () => {
    seed();
    replayAll(db);
    const row = db.select().from(variants).all()[0];
    expect(row?.decision).toBe('unknown');
    expect(row?.reviewReason).toBe('NO_AUDIO_TAG');
  });

  it('re-derives rows when a rule is disabled', () => {
    seed();
    const rule = db
      .insert(rules)
      .values({ priority: 1, action: 'not_hindi', predicate: JSON.stringify({ forumIds: [1] }) })
      .run();
    replayAll(db);
    expect(db.select().from(variants).all()[0]?.decision).toBe('not_hindi');

    db.update(rules).set({ enabled: false }).run();
    replayAll(db);
    expect(db.select().from(variants).all()[0]?.decision).toBe('unknown');
    expect(rule.changes).toBe(1);
  });
});

describe('previewRule', () => {
  it('counts only rows whose decision would change', () => {
    seed();
    seed();
    const before = previewRule(db, { forumIds: [1] }, 'hindi_dubbed');
    expect(before.affected).toBe(2);
    expect(before.sample).toHaveLength(2);

    db.insert(rules).values({ priority: 1, action: 'hindi_dubbed', predicate: JSON.stringify({ forumIds: [1] }) }).run();
    replayAll(db);
    expect(previewRule(db, { forumIds: [1] }, 'hindi_dubbed').affected).toBe(0);
  });

  it('rejects an invalid predicate', () => {
    expect(() => previewRule(db, { titleMatches: '(' }, 'hindi_dubbed')).toThrow(/regex/i);
  });
});

describe('rule hit accounting', () => {
  it('increments the hit counter of the rule that decided the rows', () => {
    seed({ audioLangs: ['tamil'], topicAudioLangs: ['tamil'], audioSourceCount: 2 });
    const rule = db
      .insert(rules)
      .values({ priority: 100, predicate: JSON.stringify({ forumIds: [1] }), action: 'hindi_original' })
      .returning()
      .get();

    replayAll(db);
    replayAll(db);

    const after = db.select().from(rules).where(eq(rules.id, rule.id)).get();
    // One variant evaluated twice by the rule: the counter is the blast radius, not a mystery zero.
    expect(after?.hits).toBe(2);
    expect(db.select().from(variants).get()?.decision).toBe('hindi_original');
  });

  it('leaves the counter alone when no rule fires', () => {
    seed({ audioLangs: ['tamil', 'hindi'], topicAudioLangs: [], audioSourceCount: 1 });
    const rule = db
      .insert(rules)
      .values({ priority: 100, predicate: JSON.stringify({ forumIds: [999] }), action: 'not_hindi' })
      .returning()
      .get();

    replayAll(db);

    expect(db.select().from(rules).where(eq(rules.id, rule.id)).get()?.hits).toBe(0);
  });
});
