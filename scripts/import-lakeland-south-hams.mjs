/**
 * Manually import two trails not in OSM:
 *   - The Lakeland Way  (~110 miles, circular, Lake District)
 *   - The South Hams Way (~35 miles, Plymouth → Kingsbridge, Devon)
 *
 * Run with:  node --env-file=.env.local scripts/import-lakeland-south-hams.mjs
 */

import pg from "pg";
const { Pool } = pg;

const BUFFER_METRES = 50;

const TRAILS = [
  {
    name:     "The Lakeland Way",
    slug:     "the-lakeland-way",
    region:   "England",
    category: "long_distance_path",
    source:   "manual",
    // Circular route ~177 km. Clockwise from Staveley through Kentmere,
    // Patterdale, Dockray, Keswick, Buttermere, Ennerdale, Wasdale,
    // Eskdale, Coniston, Hawkshead, Bowness, back to Staveley.
    coords: [
      [-2.8155, 54.3795], // Staveley (start)
      [-2.8330, 54.4279], // Kentmere
      [-2.8845, 54.4720], // Troutbeck
      [-2.9274, 54.5060], // Hartsop / Patterdale
      [-2.9630, 54.5810], // Dockray
      [-3.0508, 54.6036], // Threlkeld
      [-3.1342, 54.5996], // Keswick
      [-3.2000, 54.5988], // Braithwaite
      [-3.2786, 54.5410], // Buttermere
      [-3.3963, 54.5195], // Ennerdale Bridge
      [-3.2980, 54.4540], // Wasdale Head
      [-3.2454, 54.4071], // Boot (Eskdale)
      [-3.0746, 54.3696], // Coniston
      [-2.9931, 54.3779], // Hawkshead
      [-2.9142, 54.3606], // Bowness-on-Windermere
      [-2.8155, 54.3795], // Staveley (end — closes loop)
    ],
  },
  {
    name:     "The South Hams Way",
    slug:     "the-south-hams-way",
    region:   "South West England",
    category: "long_distance_path",
    source:   "manual",
    // ~56 km from Plympton (Plymouth) east to Kingsbridge via Ivybridge,
    // Ugborough, Modbury, and Aveton Gifford.
    coords: [
      [-4.0390, 50.3870], // Plympton (Plymouth edge)
      [-3.9187, 50.3870], // Ivybridge
      [-3.8702, 50.3745], // Ugborough
      [-3.8877, 50.3590], // Modbury
      [-3.8395, 50.2905], // Aveton Gifford
      [-3.7759, 50.2847], // Kingsbridge
    ],
  },
];

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

async function insertOrUpdate(client, trail) {
  const geojson = JSON.stringify({ type: "LineString", coordinates: trail.coords });

  const { rows: existing } = await client.query(
    "SELECT id, name FROM trails WHERE slug = $1", [trail.slug]
  );

  if (existing.length > 0) {
    const { rows } = await client.query(
      `UPDATE trails
       SET name=$1, region=$2, category=$3, source=$4,
           geometry=ST_GeomFromGeoJSON($5),
           total_distance=ROUND(ST_Length(ST_GeomFromGeoJSON($5)::geography)::numeric),
           updated_at=NOW()
       WHERE slug=$6
       RETURNING id, total_distance`,
      [trail.name, trail.region, trail.category, trail.source, geojson, trail.slug]
    );
    console.log(`  Updated  "${trail.name}" — ${(rows[0].total_distance / 1000).toFixed(1)} km`);
    return rows[0].id;
  } else {
    const { rows } = await client.query(
      `INSERT INTO trails (name, slug, region, total_distance, geometry, source, category)
       SELECT $1,$2,$3,
              ROUND(ST_Length(ST_GeomFromGeoJSON($5)::geography)::numeric),
              ST_GeomFromGeoJSON($5),
              $4,$6
       RETURNING id, total_distance`,
      [trail.name, trail.slug, trail.region, trail.source, geojson, trail.category]
    );
    console.log(`  Inserted "${trail.name}" — ${(rows[0].total_distance / 1000).toFixed(1)} km (id ${rows[0].id})`);
    return rows[0].id;
  }
}

async function matchTrail(trailId, user) {
  const activityFilter = user.include_cycling
    ? `AND a.activity_type IN ('Run','Walk','Hike','TrailRun','VirtualRun','Ride','GravelRide','MountainBikeRide')`
    : `AND a.activity_type IN ('Run','Walk','Hike','TrailRun','VirtualRun')`;

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120000'");
    const { rowCount, rows } = await client.query(
      `WITH
       combined_buffer AS (
         SELECT ST_Union(ST_Buffer(a.geometry::geography,${BUFFER_METRES})::geometry) AS geom,
                COUNT(DISTINCT a.id) AS activity_count,
                MIN(a.start_date) AS first_date, MAX(a.start_date) AS last_date
         FROM (SELECT ST_SimplifyPreserveTopology(geometry,0.001) AS geometry FROM trails WHERE id=$2) ts
         JOIN activities a
           ON  a.user_id=$1 AND a.geometry IS NOT NULL
           AND ST_DWithin(a.geometry::geography, ts.geometry::geography, ${BUFFER_METRES})
           ${activityFilter}
       ),
       coverage AS (
         SELECT t.id AS trail_id, t.total_distance,
                ST_CollectionExtract(ST_Intersection(t.geometry, cb.geom), 2) AS covered_geom,
                cb.activity_count, cb.first_date, cb.last_date
         FROM (SELECT id, total_distance, geometry FROM trails WHERE id=$2) t
         CROSS JOIN combined_buffer cb
         WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
       )
       INSERT INTO user_trail_progress
         (user_id, trail_id, completed_distance, completion_percentage,
          completed_geometry, activity_count, first_activity_date, last_activity_date)
       SELECT $1, trail_id,
         CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0
              ELSE ST_Length(covered_geom::geography) END,
         LEAST(CASE WHEN total_distance>0
                    THEN ST_Length(covered_geom::geography)/total_distance*100 ELSE 0 END, 100),
         CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL
              ELSE ST_SetSRID(ST_Multi(covered_geom),4326)::geometry(MultiLineString,4326) END,
         activity_count, first_date, last_date
       FROM coverage WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
       ON CONFLICT (user_id, trail_id) DO UPDATE SET
         completed_distance=EXCLUDED.completed_distance,
         completion_percentage=EXCLUDED.completion_percentage,
         completed_geometry=EXCLUDED.completed_geometry,
         activity_count=EXCLUDED.activity_count,
         first_activity_date=EXCLUDED.first_activity_date,
         last_activity_date=EXCLUDED.last_activity_date,
         updated_at=NOW()
       RETURNING completed_distance, completion_percentage, activity_count`,
      [user.id, trailId]
    );

    if (rowCount && rowCount > 0) {
      const r = rows[0];
      console.log(`    ${user.first_name}: ${Math.round(r.completion_percentage)}% — ${(r.completed_distance/1000).toFixed(1)} km across ${r.activity_count} activit${r.activity_count===1?"y":"ies"}`);
    } else {
      console.log(`    ${user.first_name}: no coverage`);
    }
  } finally {
    client.release();
  }
}

async function main() {
  console.log(`Connecting to ${process.env.PGHOST}/${process.env.PGDATABASE}…`);
  const client = await pool.connect();
  console.log("Connected.\n");

  const trailIds = [];
  try {
    for (const trail of TRAILS) {
      const id = await insertOrUpdate(client, trail);
      trailIds.push({ id, name: trail.name });
    }
  } finally {
    client.release();
  }

  const { rows: users } = await pool.query(
    "SELECT id, first_name, last_name, include_cycling FROM users ORDER BY created_at"
  );

  console.log("\nRunning matching engine…");
  for (const { id, name } of trailIds) {
    console.log(`\n  ${name}:`);
    for (const user of users) {
      await matchTrail(id, user);
    }
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
