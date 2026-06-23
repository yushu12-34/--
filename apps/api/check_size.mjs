import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://anime_canvas_app:yushu123@192.168.100.100:5432/anime_canvas",
  max: 1,
  connectionTimeoutMillis: 5000,
});

async function main() {
  const client = await pool.connect();
  try {
    const r1 = await client.query(`select pg_size_pretty(sum(pg_column_size(update_data))::bigint) as total_size, count(*) as cnt, pg_size_pretty(max(pg_column_size(update_data))::bigint) as max_size from yjs_updates`);
    console.log("yjs_updates size:", r1.rows[0]);

    const r2 = await client.query(`select pg_size_pretty(sum(pg_column_size(update_data))::bigint) as total_size, count(*) as cnt, pg_size_pretty(max(pg_column_size(update_data))::bigint) as max_size from yjs_snapshots`);
    console.log("yjs_snapshots size:", r2.rows[0]);

    const r3 = await client.query(`select pg_size_pretty(sum(pg_column_size(snapshot))::bigint) as total_size, count(*) as cnt from canvases`);
    console.log("canvases snapshot size:", r3.rows[0]);

    const r4 = await client.query(`select pg_size_pretty(pg_database_size('anime_canvas')) as db_size`);
    console.log("database size:", r4.rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
