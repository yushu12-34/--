import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://anime_canvas_app:yushu123@192.168.100.100:5433/anime_canvas",
  max: 1,
  connectionTimeoutMillis: 5000,
});

async function main() {
  const client = await pool.connect();
  try {
    // 找到所有等待 advisory lock 的连接，以及持有锁的连接
    const r = await client.query(`
      select pid, state, wait_event_type, wait_event,
             extract(epoch from (now() - query_start)) as wait_seconds,
             left(query, 120) as query
      from pg_stat_activity
      where datname = 'anime_canvas' and pid <> pg_backend_pid()
      order by query_start asc
    `);
    console.log("=== All connections ===");
    for (const row of r.rows) {
      console.log(`PID ${row.pid} | state=${row.state} | wait=${row.wait_event_type}/${row.wait_event} | ${Math.round(row.wait_seconds)}s | ${row.query}`);
    }

    // 终止所有卡住的连接（除了当前连接）
    for (const row of r.rows) {
      if (row.state === "active" || row.state === "idle in transaction") {
        console.log(`Terminating PID ${row.pid}...`);
        await client.query(`select pg_terminate_backend(${row.pid})`);
      }
    }
    console.log("Done.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
