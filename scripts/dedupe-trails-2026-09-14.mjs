/**
 * One-off cleanup, run 2026-09-14: three trails in the `trails` table turned
 * out to be exact/near-exact geometric duplicates of another trail already
 * present (found via a systematic scan for identical name, and identical
 * distance+part-count+point-count fingerprints, then confirmed with
 * ST_HausdorffDistance ≈ 0 — not just similar names):
 *
 *   - "Coast to Coast Trail" — pixel-identical to "Mineral Tramways Coast to
 *     Coast Trail" (Cornwall). Kept the specific/official name.
 *   - "The Poets' Trail - Creggan Loop" — pixel-identical to "...Creggan
 *     Route". No user progress on either; picked "Route" arbitrarily.
 *   - "Glyndŵr's Way" tagged region "England" — near-identical (Hausdorff
 *     ≈ 500m over 217km) to the "Mid-Wales"-tagged entry, whose distance
 *     (217.3km) matches the trail's official length; "England" was a
 *     mistagged/lower-quality import. No user progress on either.
 *
 * NOT a duplicate, deliberately left alone: the main "Coast to Coast"
 * national-trail entry (309km) plus its three official stage segments
 * (St Bees→Shap→Richmond→Robin Hood's Bay) — confirmed the main trail's
 * geometry is the union of the three segments, and 7 different users have
 * real, distinct progress across all four, so this is intentional
 * whole-route + stage-by-stage tracking, not accidental duplication.
 *
 * Only Kate Jones, Luke Davis, and Sophie Davis had progress on any of the
 * three deleted trails. Kate and Sophie already had identical progress on
 * the kept "Coast to Coast Trail" duplicate; only Luke Davis's progress
 * needed merging across (he only had it on the trail being deleted).
 *
 * All four FK tables (user_trail_progress, activity_trail_matches,
 * trail_match_checks, user_trail_manual_segments) use ON DELETE CASCADE on
 * trail_id, so deleting the trails row alone was sufficient cleanup for
 * everything except the merge itself.
 *
 * Not idempotent to re-run as-is (the trails are already gone), kept only
 * as a record of what happened and a template for the next such cleanup.
 */
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ ssl: { rejectUnauthorized: false } });
pool.on("error", (e) => console.error("[pool err]", e.message));

const KEEP_C2C = "af57fa0c-9412-46f0-8aa0-81b8a4fca460"; // Mineral Tramways Coast to Coast Trail
const DELETE_C2C = "4ddda0ff-0a25-46dd-86b2-69979c1df8b1"; // Coast to Coast Trail

const KEEP_POETS = "90e704a3-dc48-4b5e-9601-4cc8e833f09f"; // Creggan Route
const DELETE_POETS = "e116972a-385b-4a6c-8d56-ca989011a1da"; // Creggan Loop

const KEEP_GLYNDWR = "9136da69-e63f-4869-afc8-1e9c57928c71"; // Mid-Wales
const DELETE_GLYNDWR = "e35457c1-78a5-4923-8625-e1feb83cc0c5"; // England

const client = await pool.connect();
client.on("error", (e) => console.error("[client err]", e.message));
try {
  await client.query("BEGIN");

  // --- Pre-flight counts ---
  const { rows: before } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS trails,
       (SELECT COUNT(*) FROM user_trail_progress) AS utp,
       (SELECT COUNT(*) FROM activity_trail_matches) AS atm,
       (SELECT COUNT(*) FROM trail_match_checks) AS tmc`
  );
  console.log("BEFORE:", before[0]);

  // --- Merge: copy Luke Davis's progress from the trail being deleted onto the one being kept ---
  const { rowCount: mergedRows } = await client.query(
    `INSERT INTO user_trail_progress (
       user_id, trail_id, completed_distance, completion_percentage,
       completed_geometry, activity_count, first_activity_date, last_activity_date
     )
     SELECT user_id, $2, completed_distance, completion_percentage,
            completed_geometry, activity_count, first_activity_date, last_activity_date
     FROM user_trail_progress
     WHERE trail_id = $1
     ON CONFLICT (user_id, trail_id) DO NOTHING`,
    [DELETE_C2C, KEEP_C2C]
  );
  console.log(`Merged ${mergedRows} user_trail_progress row(s) from Coast to Coast Trail onto Mineral Tramways Coast to Coast Trail (expect 1 — Luke Davis; Kate/Sophie already have identical rows on the kept trail, so ON CONFLICT DO NOTHING skips them)`);

  // --- Delete the three duplicate trail rows (cascades to user_trail_progress,
  //     activity_trail_matches, trail_match_checks, user_trail_manual_segments) ---
  for (const [label, id] of [
    ["Coast to Coast Trail", DELETE_C2C],
    ["The Poets' Trail - Creggan Loop", DELETE_POETS],
    ["Glyndwr's Way (England)", DELETE_GLYNDWR],
  ]) {
    const { rowCount } = await client.query(`DELETE FROM trails WHERE id = $1`, [id]);
    console.log(`Deleted trail "${label}" (${id}): ${rowCount} row`);
  }

  // --- Post-flight counts ---
  const { rows: after } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS trails,
       (SELECT COUNT(*) FROM user_trail_progress) AS utp,
       (SELECT COUNT(*) FROM activity_trail_matches) AS atm,
       (SELECT COUNT(*) FROM trail_match_checks) AS tmc`
  );
  console.log("AFTER:", after[0]);

  // --- Verify the survivors have correct data ---
  const { rows: verify } = await client.query(
    `SELECT u.first_name, u.last_name, utp.completed_distance, utp.completion_percentage, utp.activity_count
     FROM user_trail_progress utp JOIN users u ON u.id=utp.user_id
     WHERE utp.trail_id = $1 ORDER BY u.first_name`,
    [KEEP_C2C]
  );
  console.log("\nMineral Tramways Coast to Coast Trail progress after merge:", verify);

  await client.query("COMMIT");
  console.log("\nCOMMITTED.");
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("FAILED, rolled back:", err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
