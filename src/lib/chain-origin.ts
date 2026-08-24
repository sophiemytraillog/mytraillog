// Canonical origin for server-to-server calls between this app's own API
// routes (the background chain/drain hop dispatches in match-chain.ts and
// description-chain.ts). Deliberately NOT derived from whatever request
// triggered the chain (`new URL(request.url).origin`) — that was the
// previous approach, and it's unreliable: Vercel Cron Jobs and other
// internal invocations don't always arrive on the canonical custom domain.
// This project's `mytraillog.vercel.app` alias 301-redirects to
// www.mytraillog.com, and a 301 silently downgrades a POST to a GET per
// the fetch spec — which breaks a chain's own self-dispatch call (each hop
// POSTs to /api/internal/continue-*) the moment `origin` happens to
// resolve to that alias instead of the real domain.
//
// Root-caused 2026-08-24: cron-triggered description drains for Kate
// Jones and Glen Smith each processed exactly one user then silently
// stopped, despite up to 80 hops being available and plenty of backlog
// left — while two other users (Luke Barton-Davis, Paul Crowe) went
// completely untouched for 4+ days despite being first in the
// least-recently-drained queue. www.mytraillog.com is the one domain
// confirmed NOT to redirect (verified directly: apex and the .vercel.app
// alias both redirect to it, it redirects nowhere) — hardcoding it here
// removes this failure mode regardless of which URL a chain happened to
// be triggered from.
export const CHAIN_DISPATCH_ORIGIN = "https://www.mytraillog.com";
