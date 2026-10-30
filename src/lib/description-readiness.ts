import type { Pool } from "pg";
import { pool } from "@/lib/db";

// Strava descriptions are only written once a user is FULLY synced and
// matched (2026-10-30): sync_status = 'complete' AND every current trail has
// a trail_match_checks row (e.g. 1,181/1,181). Before that, the trail
// percentages a description would quote can still change as more history
// arrives or more trails get checked — and a description that later shows
// different numbers looks wrong. Activities skipped here keep
// strava_description_updated = FALSE, so the background drain writes them
// once the user is ready.
//
// Note: adding a new trail to the catalog drops everyone below the total
// until it's been checked for them, pausing descriptions until then.

/** SQL boolean expression, given the alias of a joined `users` row. */
export function descriptionsReadySql(userAlias: string): string {
  return `(${userAlias}.sync_status = 'complete'
           AND (SELECT COUNT(*) FROM trail_match_checks c JOIN trails t ON t.id = c.trail_id
                WHERE c.user_id = ${userAlias}.id)
               >= (SELECT COUNT(*) FROM trails))`;
}

/** Same rule, for one user. */
export async function isReadyForDescriptions(userId: string, dbPool: Pool = pool): Promise<boolean> {
  const { rows: [r] } = await dbPool.query<{ ready: boolean }>(
    `SELECT ${descriptionsReadySql("u")} AS ready FROM users u WHERE u.id = $1`,
    [userId]
  );
  return r?.ready === true;
}
