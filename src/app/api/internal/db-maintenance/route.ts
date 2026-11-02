import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Daily VACUUM + ANALYZE of every table in the public schema.
//
// Why (2026-11-02): /admin was timing out and even `SELECT COUNT(*) FROM
// activities` took 60s+. Postgres's statistics said `trails` had 0 rows
// (it has ~1,200) and the 275MB `activities` table had never been vacuumed
// or analyzed — autovacuum's change counters appear to have been reset, so
// it never decided the tables needed attention. With stale stats the planner
// picks bad plans; with no vacuum, counts can't use index-only scans. A
// manual VACUUM/ANALYZE took that count from 60s+ to 57ms. This job keeps
// it that way regardless of what autovacuum decides.
//
// Plain VACUUM (not FULL) takes no blocking locks, so it's safe while the
// app is live. Runs on its own short-lived connection, outside the app's
// pools; each statement is autocommit, so it works through the
// transaction-mode pooler. Each one is nominally bound by the server's
// default statement_timeout (2min), but on a busy database ANALYZE of
// `activities` (PostGIS stats on geometry) was seen running 6+ min without
// being cancelled. So no new statement starts after TIME_BUDGET_MS; if one
// still overruns maxDuration, Vercel ends the function but Postgres finishes
// the statement on its own (harmless), and later tables wait for tomorrow.
const TIME_BUDGET_MS = 180_000;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/db-maintenance] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const started = Date.now();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  client.on("error", (err) => console.error("[internal/db-maintenance] Client error:", err.message));

  const results: { table: string; step: string; ms: number; error?: string }[] = [];
  const skipped: string[] = [];

  try {
    await client.connect();
    // Smallest first: ANALYZE of `activities` alone has taken 7 min under
    // load, and going first it used to eat the whole budget so nothing else
    // (including `trails`, whose stale row count caused the original
    // slowdown) got done.
    const { rows } = await client.query<{ relname: string }>(
      `SELECT relname FROM pg_stat_user_tables
       WHERE schemaname = 'public'
       ORDER BY pg_total_relation_size(relid) ASC`
    );
    const tables = rows.map((r) => r.relname);

    for (let i = 0; i < tables.length; i++) {
      const ident = `public."${tables[i].replace(/"/g, '""')}"`;
      for (const step of ["VACUUM", "ANALYZE"] as const) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          skipped.push(`${step} ${tables[i]}`);
          continue;
        }
        const t = Date.now();
        try {
          await client.query(`${step} ${ident}`);
          results.push({ table: tables[i], step, ms: Date.now() - t });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[internal/db-maintenance] ${step} ${tables[i]} failed:`, message);
          results.push({ table: tables[i], step, ms: Date.now() - t, error: message });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[internal/db-maintenance] Failed:", message);
    return NextResponse.json({ ok: false, error: message, results }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }

  const failed = results.filter((r) => r.error);
  const summary = {
    ok: failed.length === 0 && skipped.length === 0,
    totalMs: Date.now() - started,
    tables: new Set(results.map((r) => r.table)).size,
    failed,
    skipped,
    slowest: [...results].sort((a, b) => b.ms - a.ms).slice(0, 5),
  };
  console.log("[internal/db-maintenance]", JSON.stringify(summary));
  return NextResponse.json(summary);
}
