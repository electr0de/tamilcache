import { and, eq, isNull } from 'drizzle-orm';
import { logEvent, type Db } from '@tamilcache/db';
import { topics, variants } from '@tamilcache/db/schema';

export interface RetentionResult {
  variants: number;
  topics: number;
}

/**
 * The cache is a Hindi indexer, not a mirror of the site.
 *
 * A variant is kept when it is `hindi_dubbed`, `hindi_original`, or still ambiguous (`unknown`, or
 * carrying a review reason); everything else is deleted, and a topic that no longer has a single
 * kept variant is deleted with it (its links cascade). Hindi releases are posted in every language
 * section, so this is a decision about the *release*, never about the forum it came from.
 *
 * Deliberately a sweep rather than a skip at persist time: the classifier needs the row to classify
 * it and rule replay needs it once. Re-crawling restores anything pruned by mistake.
 */
export function pruneRetention(db: Db): RetentionResult {
  const doomed = db
    .select({ id: variants.id, topicId: variants.topicId })
    .from(variants)
    .where(and(eq(variants.decision, 'not_hindi'), isNull(variants.reviewReason)))
    .all();
  if (doomed.length === 0) return { variants: 0, topics: 0 };

  const affectedTopics = [...new Set(doomed.map((row) => row.topicId))];

  const result = db.transaction(
    () => {
      db.delete(variants)
        .where(and(eq(variants.decision, 'not_hindi'), isNull(variants.reviewReason)))
        .run();

      let topicsDeleted = 0;
      for (const topicId of affectedTopics) {
        const remaining = db.select({ id: variants.id }).from(variants).where(eq(variants.topicId, topicId)).all();
        if (remaining.length === 0) {
          db.delete(topics).where(eq(topics.id, topicId)).run();
          topicsDeleted++;
        }
      }
      return { variants: doomed.length, topics: topicsDeleted };
    },
    { behavior: 'immediate' },
  );

  logEvent(db, {
    source: 'worker',
    level: 'info',
    class: 'diag',
    scope: 'persist',
    event: 'retention',
    message: `pruned ${result.variants} non-Hindi variants and ${result.topics} emptied topics`,
    detail: { ...result },
  });

  return result;
}
