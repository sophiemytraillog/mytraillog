// Which activities AUTOMATIC Strava description writes may touch
// (first sync, background drain/cron sweep, webhook) — 2026-10-30.
//
// Historical descriptions are a Premium feature:
// - 'active' (founding testers + paying subscribers): no cut-off — every
//   matched activity, including old history.
// - everyone else (trial): only activities recorded on/after
//   auto_description_since, falling back to their signup time (created_at)
//   for accounts that predate that column.
//
// The manual "Update historical activity descriptions" route
// (/api/update-descriptions) doesn't use this — it has its own Premium gate.

/**
 * SQL expression for the cut-off timestamp, given the alias of a joined
 * `users` row. Compare with `activities.start_date >= <expr>`.
 */
export function autoDescriptionCutoffSql(userAlias: string): string {
  return `(CASE WHEN ${userAlias}.subscription_status = 'active' THEN '-infinity'::timestamptz
            ELSE COALESCE(${userAlias}.auto_description_since, ${userAlias}.created_at) END)`;
}

/** Same rule in JS. Returns null when there's no cut-off. */
export function autoDescriptionCutoff(user: {
  subscription_status: string | null;
  auto_description_since: Date | string | null;
  created_at: Date | string;
}): Date | null {
  if (user.subscription_status === "active") return null;
  return new Date(user.auto_description_since ?? user.created_at);
}
