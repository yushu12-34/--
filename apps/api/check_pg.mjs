import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://anime_canvas_app:yushu123@192.168.100.100:5432/anime_canvas",
  max: 1,
  connectionTimeoutMillis: 5000,
});

async function main() {
  const client = await pool.connect();
  try {
    const r1 = await client.query(`
      select pid, state, wait_event_type, wait_event, query_start, state_change, left(query, 100) as query
      from pg_stat_activity
      where datname = 'anime_canvas'
      order by query_start asc
    `);
    console.log("=== Active connections ===");
    console.table(r1.rows);

    const r2 = await client.query(`
      select pid, relation::regclass as rel, mode, granted, query_start
      from pg_locks l
      join pg_stat_activity a on l.pid = a.pid
      where a.datname = 'anime_canvas'
      order by granted asc, query_start asc
    `);
    console.log("=== Locks ===");
    console.table(r2.rows);

    const r3 = await client.query(`
      select count(*) as total, count(*) filter (where state = 'idle') as idle,
      count(*) filter (where state = 'active') as active,
      count(*) filter (where state = 'idle in transaction') as idle_in_txn
      from pg_stat_activity where datname = 'anime_canvas'
    `);
    console.log("=== Connection summary ===");
    console.table(r3.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
