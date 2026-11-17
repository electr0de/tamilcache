import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { openDb, type Db } from '@tamilcache/db';
import { forums, media, overrides, rules, topics, variants } from '@tamilcache/db/schema';
import { classify, evidenceHash, ruleSchema, type RuleRow } from '@tamilcache/shared';

/**
 * Bump whenever classification semantics change. Stored on every variant so a replay can be
 * reasoned about after the fact ("this row was decided by v1").
 */
export const CLASSIFIER_VERSION = 1;

export interface ReplayResult {
  scanned: number;
  updated: number;
}

/**
 * Re-evaluate every variant against the current rule set, overrides and provider data.
 *
 * Idempotent by construction: a row whose decision/source/reason/version already match is not
 * touched, so running this twice updates 0 rows the second time. That property is what makes
 * "Commit + replay" safe to press repeatedly in the UI.
 */
export function replayAll(db: Db): ReplayResult {
  const ruleRows: RuleRow[] = db
    .select()
    .from(rules)
    .where(eq(rules.enabled, true))
    .orderBy(rules.priority, rules.id)
    .all()
    .map((row) => ({
      id: row.id,
      action: row.action,
      predicate: ruleSchema.parse(JSON.parse(row.predicate)),
    }));

  const overrideByHash = new Map(
    db
      .select()
      .from(overrides)
      .all()
      .map((row) => [row.evidenceHash, row.action] as const),
  );

  const rows = db
    .select({
      id: variants.id,
      topicId: variants.topicId,
      resolution: variants.resolution,
      audioLangs: variants.audioLangs,
      topicAudioLangs: variants.topicAudioLangs,
      audioSourceCount: variants.audioSourceCount,
      sourceTagRaw: variants.sourceTagRaw,
      decision: variants.decision,
      decisionSource: variants.decisionSource,
      reviewReason: variants.reviewReason,
      classifierVersion: variants.classifierVersion,
      forumId: topics.forumId,
      forumName: forums.name,
      slug: topics.slug,
      rawTitle: topics.rawTitle,
      poster: topics.poster,
      originalLanguage: media.originalLanguage,
    })
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .leftJoin(media, eq(variants.mediaId, media.id))
    .all();

  let updated = 0;
  // The Rules page shows `hits` as the blast radius of a rule. It was never written anywhere, so
  // a board-wide rule that deleted 796 pages displayed "0 hits" — the number must come from here.
  const hits = new Map<number, number>();

  db.transaction(
    () => {
      for (const row of rows) {
        const evidence = {
          forumId: row.forumId,
          forumName: row.forumName,
          slug: row.slug,
          rawTitle: row.rawTitle,
          poster: row.poster,
          sourceTagRaw: row.sourceTagRaw,
          resolution: row.resolution,
          audioLangs: row.audioLangs,
          topicAudioLangs: row.topicAudioLangs,
          audioSourceCount: row.audioSourceCount,
        };

        const result = classify(evidence, {
          ruleSet: ruleRows,
          override: overrideByHash.get(evidenceHash(evidence)) ?? null,
          providerOriginalLanguage: row.originalLanguage,
        });

        if (result.ruleId !== null) hits.set(result.ruleId, (hits.get(result.ruleId) ?? 0) + 1);

        if (
          row.decision === result.decision &&
          row.decisionSource === result.source &&
          row.reviewReason === result.reviewReason &&
          row.classifierVersion === CLASSIFIER_VERSION
        ) {
          continue;
        }

        db.update(variants)
          .set({
            decision: result.decision,
            decisionSource: result.source,
            confidence: result.confidence,
            reviewReason: result.reviewReason,
            classifierVersion: CLASSIFIER_VERSION,
          })
          .where(eq(variants.id, row.id))
          .run();
        updated++;
      }

      for (const [ruleId, count] of hits) {
        db.update(rules).set({ hits: sql`${rules.hits} + ${count}` }).where(eq(rules.id, ruleId)).run();
      }
    },
    { behavior: 'immediate' },
  );

  return { scanned: rows.length, updated };
}

/** Dry-run used by the review queue's "apply to N similar" preview. */
export function previewRule(
  db: Db,
  predicate: unknown,
  action: 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'ignore',
): { affected: number; sample: Array<{ id: number; slug: string; decision: string }> } {
  const parsed = ruleSchema.parse(predicate);
  const rule: RuleRow = { action, predicate: parsed };

  const rows = db
    .select({
      id: variants.id,
      decision: variants.decision,
      resolution: variants.resolution,
      audioLangs: variants.audioLangs,
      topicAudioLangs: variants.topicAudioLangs,
      audioSourceCount: variants.audioSourceCount,
      sourceTagRaw: variants.sourceTagRaw,
      forumId: topics.forumId,
      forumName: forums.name,
      slug: topics.slug,
      rawTitle: topics.rawTitle,
      poster: topics.poster,
      originalLanguage: media.originalLanguage,
    })
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .leftJoin(media, eq(variants.mediaId, media.id))
    .all();

  const affected: Array<{ id: number; slug: string; decision: string }> = [];
  for (const row of rows) {
    const evidence = {
      forumId: row.forumId,
      forumName: row.forumName,
      slug: row.slug,
      rawTitle: row.rawTitle,
      poster: row.poster,
      sourceTagRaw: row.sourceTagRaw,
      resolution: row.resolution,
      audioLangs: row.audioLangs,
      topicAudioLangs: row.topicAudioLangs,
      audioSourceCount: row.audioSourceCount,
    };
    const next = classify(evidence, { ruleSet: [rule], providerOriginalLanguage: row.originalLanguage });
    if (next.decision !== row.decision) affected.push({ id: row.id, slug: row.slug, decision: next.decision });
  }

  return { affected: affected.length, sample: affected.slice(0, 20) };
}

// `node dist/replay.js` — re-evaluate every variant against the current rules, overrides and
// provider data, then re-run selection because a changed decision can change which release wins.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const { selectPreferredAcrossTitles } = await import('./select.js');
    const db = openDb(process.env['DB_PATH'] ?? './data/tamilcache.db');
    const replay = replayAll(db);
    const selection = selectPreferredAcrossTitles(db);
    console.log(JSON.stringify({ replay, selection }, null, 2));
  })().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
