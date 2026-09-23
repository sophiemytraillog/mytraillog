import { NextRequest, NextResponse } from "next/server";
import { runExternalDrainBatch } from "@/lib/description-chain";
import { runExternalMatchDrainBatch } from "@/lib/match-chain";
import { runExternalSyncResumeBatch } from "@/lib/sync-chain";

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
// means matching now advances on the exact same external cadence as
// descriptions, with no separate scheduler to set up (originally ~2min,
// widened to a 24-hour 10-minute cadence 2026-09-22 — see drain.yml).
//
// Sync resume added to this same call, 2026-09-22, same reasoning again:
// the reactive sync chain (sync-chain.ts's runSyncChunkAndChain) only fires
// off the browser's first sync click, and is itself capped at a handful of
// hops precisely BECAUSE self-dispatch chains hit Vercel's own
// loop-detection wall (see that file's MAX_CHAIN_HOPS comment) — a large
// sync, or a chain that dies for any reason (dispatch failure, a deploy
// restarting mid-chain), previously just sat at sync_status='syncing'
// until either the daily cron (resume-stuck-syncs, Hobby-plan-limited to
// once a day) or the next dashboard visit's 60s self-heal nudge happened to
// notice. This closes that gap the same way matching's did: one bounded
// runSyncChunk call for whichever sync has gone stalest, on the same
// external cadence already proven for the other two.
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
// Unchanged total (2026-09-22) — the sync-resume phase below is carved out
// of this SAME envelope, not added on top of it. Extending the overall
// ceiling instead of subdividing it further is exactly how the
// FUNCTION_INVOCATION_TIMEOUT regression above happened in the first place;
// a third phase gets a third slice of the same budget, not a bigger pie.
const TOTAL_REQUEST_BUDGET_MS = 45_000;
const MIN_USEFUL_MATCH_BUDGET_MS = 3_000;
const MIN_USEFUL_SYNC_RESUME_BUDGET_MS = 3_000;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    // ?secret= query param accepted alongside the Authorization header
    // (2026-09-23) — a plain link (e.g. tapped from the "kick this along"
    // link in the new-signup alert email, see settings/route.ts) can't set
    // a custom header, so this is what lets that link actually work from a
    // phone without needing curl/Postman. Same CRON_SECRET value, no new
    // secret to provision; GitHub Actions' header-based call is unaffected.
    const querySecret = request.nextUrl.searchParams.get("secret");
    if (auth !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/drain-batch] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const startedAt = Date.now();
  const descriptions = await runExternalDrainBatch();

  const remainingAfterDescriptions = TOTAL_REQUEST_BUDGET_MS - (Date.now() - startedAt);
  if (remainingAfterDescriptions < MIN_USEFUL_MATCH_BUDGET_MS) {
    return NextResponse.json({
      descriptions,
      matching: { skipped: true, reason: "insufficient time remaining after description phase" },
      syncResume: { skipped: true, reason: "insufficient time remaining after description phase" },
    });
  }

  const matching = await runExternalMatchDrainBatch(remainingAfterDescriptions);

  const remainingAfterMatching = TOTAL_REQUEST_BUDGET_MS - (Date.now() - startedAt);
  if (remainingAfterMatching < MIN_USEFUL_SYNC_RESUME_BUDGET_MS) {
    return NextResponse.json({
      descriptions,
      matching,
      syncResume: { skipped: true, reason: "insufficient time remaining after matching phase" },
    });
  }

  const syncResume = await runExternalSyncResumeBatch(remainingAfterMatching);
  return NextResponse.json({ descriptions, matching, syncResume });
}
