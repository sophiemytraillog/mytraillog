import { pool } from "@/lib/db";

/**
 * Durable, queryable log of the sync -> matching pipeline (see sync_log in
 * schema.sql). Fire-and-forget by design: a logging failure must never break
 * the actual sync/matching it's describing, so every call site can call this
 * without try/catch of its own.
 */
export function logSyncEvent(
  userId: string,
  event: string,
  detail?: Record<string, unknown>
): void {
  pool
    .query(
      `INSERT INTO sync_log (user_id, event, detail) VALUES ($1, $2, $3)`,
      [userId, event, detail ? JSON.stringify(detail) : null]
    )
    .catch((err) => {
      console.error(`[sync-log] Failed to log '${event}' for user ${userId}:`, err.message);
    });
}
