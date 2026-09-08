import { NextRequest, NextResponse } from "next/server";
import { runExternalDrainBatch } from "@/lib/description-chain";
import { runExternalMatchDrainBatch } from "@/lib/match-chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Entry point for an EXTERNAL scheduler (cron-job.org or similar), not for
// anything inside this app — see description-chain.ts's runExternalDrainBatch
// for the full root-cause writeup (2026-08-27). The self-dispatching drain
// chain (continue-description-drain) hits Vercel's own loop-detection
// protection (HTTP 508) after 4-5 hops, deterministically, because each hop
// calls itself via HTTP to trigger the next one. An external scheduler
// hitting this route on a fixed interval sends independent requests with no
// shared invocation lineage, so that protection never engages — each call
// just does one bounded batch (looping across as many users as fit in ~50s)
// and returns, synchronously, with a summary in the response body so the
// scheduler's own run history shows real progress instead of an opaque 200.
//
// GET (not POST) specifically because external cron services vary in how
// easily they support a JSON POST body — this endpoint needs none, so GET
// keeps setup to "URL + one header" for whatever service ends up calling it.
//
// Trail matching added to this same call, 2026-09-07: the reactive match
// chain only fires off a sync or dashboard visit, and the daily cron drain
// is a single small hop once a day — a user who does neither (confirmed:
// Luke Davis sat at 236/1,182 trails checked for two full days, untouched)
// never got any further matching progress at all between those triggers.
// Piggybacking one small matching batch onto every description-drain call
// means matching now advances on the exact same ~2-minute external cadence
// as descriptions, with no separate scheduler to set up.
//
// TOTAL_REQUEST_BUDGET_MS added 2026-09-08, the day after the above
// shipped: two real production calls came back as Vercel's own raw
// FUNCTION_INVOCATION_TIMEOUT (504) at the full 60s maxDuration, each
// leaving an orphaned MATCH_SQL query still running against the database
// afterward (confirmed via pg_stat_activity — 2m34s and 1m10s, well past
// when the calling function had already been killed). runExternalDrainBatch
// (descriptions) was never the problem — three separate real calls in the
// same window each completed in ~5s — it was matching's own soft,
// unenforced budget (see runExternalMatchDrainBatch's comment). Rather
// than give matching a second fixed budget and hope the two never overrun
// TOGETHER, this measures how long descriptions actually took and gives
// matching only whatever's left of one shared 45s ceiling (15s margin
// under Vercel's 60s maxDuration, for response serialization / cold-start
// overhead) — mathematically bounding the COMBINED total, not just each
// phase independently. If descriptions alone already ate most of the
// budget, matching is skipped entirely for this call rather than starting
// an attempt with too little time to matter; it'll get picked up on the
// next call a couple of minutes later, same as any other candidate that
// doesn't get to run this round.
const TOTAL_REQUEST_BUDGET_MS = 45_000;
const MIN_USEFUL_MATCH_BUDGET_MS = 3_000;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/drain-batch] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const startedAt = Date.now();
  const descriptions = await runExternalDrainBatch();

  const remainingMs = TOTAL_REQUEST_BUDGET_MS - (Date.now() - startedAt);
  if (remainingMs < MIN_USEFUL_MATCH_BUDGET_MS) {
    return NextResponse.json({
      descriptions,
      matching: { skipped: true, reason: "insufficient time remaining after description phase" },
    });
  }

  const matching = await runExternalMatchDrainBatch(remainingMs);
  return NextResponse.json({ descriptions, matching });
}
