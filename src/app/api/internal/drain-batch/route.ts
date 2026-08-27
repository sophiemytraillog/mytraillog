import { NextRequest, NextResponse } from "next/server";
import { runExternalDrainBatch } from "@/lib/description-chain";

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

  const summary = await runExternalDrainBatch();
  return NextResponse.json(summary);
}
