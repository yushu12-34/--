const REQUIRED_TABLES = [
  "users",
  "user_devices",
  "projects",
  "project_members",
  "canvases",
  "assets",
  "tasks",
  "providers",
  "models",
  "system_events",
  "yjs_updates",
  "yjs_snapshots",
];

import { getPoolCtor, loadPgDriver } from "./postgres-driver.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Do not print it; set it in .env or the current shell.");
  process.exit(1);
}

function databaseHost(connectionString) {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return "";
  }
}

const host = databaseHost(process.env.DATABASE_URL);
if (["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.warn("DATABASE_URL points to localhost. This is fine only when the API and PostgreSQL run on the same machine; LAN deployment should use the PostgreSQL server IP/host.");
  console.warn("");
}

let pg;
try {
  pg = await loadPgDriver();
} catch (error) {
  console.error(`PostgreSQL driver is not installed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const Pool = getPoolCtor(pg);
if (!Pool) {
  console.error("PostgreSQL driver did not expose Pool.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5000),
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined,
});

try {
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
    console.error(`PostgreSQL connection failed${code}: ${message}`);
    console.error("Check that DATABASE_URL uses the server LAN IP/host, port 5432 is reachable, and the app user password is correct.");
    process.exit(1);
  }
  try {
    const identity = await client.query("select current_database() as database, current_user as user, now() as checked_at");
    const tableResult = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[]) order by table_name",
      [REQUIRED_TABLES],
    );
    const found = new Set(tableResult.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((table) => !found.has(table));

    console.log("PostgreSQL connection OK");
    console.log(`database: ${identity.rows[0].database}`);
    console.log(`user: ${identity.rows[0].user}`);
    console.log(`checked_at: ${identity.rows[0].checked_at.toISOString()}`);
    console.log("");

    if (missing.length) {
      console.log(`Missing tables: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("Table counts:");
      for (const table of REQUIRED_TABLES) {
        const count = await client.query(`select count(*)::int as count from ${table}`);
        console.log(`${table.padEnd(18)} ${String(count.rows[0].count).padStart(6)}`);
      }
    }
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
