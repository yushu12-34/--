import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertRequiredTables,
  loadPostgresSnapshot,
  lockSnapshotWrite,
  preparePostgresSnapshot,
  replacePostgresSnapshot,
} from "../apps/api/src/services/postgresStore.js";
import {
  adjustedExpectedCounts,
  analyzePreparedSnapshot,
  defaultDbFile,
  diffCounts,
  printCounts,
  printIssues,
  readSourceDb,
  shouldBlockMigration,
  summarizeSnapshot,
} from "./postgres-migration-utils.mjs";
import { getPoolCtor, loadPgDriver } from "./postgres-driver.mjs";

function parseArgs(argv) {
  const options = {
    apply: false,
    confirm: "",
    source: defaultDbFile(),
    backupDir: path.resolve("data", "postgres-migration-backups"),
    strict: process.env.POSTGRES_MIGRATION_STRICT !== "false",
    allowNonEmpty: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--allow-non-empty") options.allowNonEmpty = true;
    else if (arg === "--no-strict") options.strict = false;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--source") options.source = argv[++index];
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg.startsWith("--backup-dir=")) options.backupDir = arg.slice("--backup-dir=".length);
    else if (arg === "--confirm") options.confirm = argv[++index];
    else if (arg.startsWith("--confirm=")) options.confirm = arg.slice("--confirm=".length);
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function dataBackendLooksActive() {
  const backend = String(process.env.DATA_BACKEND || "json").toLowerCase();
  return backend === "postgres" || backend === "postgresql";
}

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set it in the current shell; the script will not print it.");
  }
}

async function createPool() {
  let pg;
  try {
    pg = await loadPgDriver();
  } catch (error) {
    throw new Error(`PostgreSQL driver is not installed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const Pool = getPoolCtor(pg);
  if (!Pool) throw new Error("PostgreSQL driver did not expose Pool.");
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5000),
    ssl: process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
  });
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writePostgresBackup(snapshot, backupDir) {
  await mkdir(backupDir, { recursive: true });
  const file = path.join(backupDir, `${timestampForFile()}_postgres-before-import.json`);
  await writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");
  return file;
}

function isPostgresEmpty(snapshot = {}) {
  return Object.values(summarizeSnapshot(snapshot)).every((count) => count === 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();

  const sourceDb = await readSourceDb(options.source);
  const prepared = preparePostgresSnapshot(sourceDb, { timestamp: new Date().toISOString() });
  const analysis = analyzePreparedSnapshot(sourceDb, prepared);

  console.log(`PostgreSQL migration source: ${options.source}`);
  console.log(`Mode: ${options.apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Strict warnings: ${options.strict ? "yes" : "no"}`);
  console.log("");
  console.log("Source counts after adapter normalization:");
  printCounts(analysis.counts);
  console.log("");

  if (analysis.issues.length) {
    printIssues(analysis);
  } else {
    console.log("No source issues found.");
    console.log("");
  }

  if (shouldBlockMigration(analysis, { strict: options.strict })) {
    throw new Error("Migration blocked by source analysis issues. Use --no-strict only after deciding how to handle warnings.");
  }

  if (options.apply) {
    if (options.confirm !== "replace-postgres") {
      throw new Error("Refusing to write PostgreSQL without --confirm replace-postgres.");
    }
    if (dataBackendLooksActive() && process.env.ALLOW_ACTIVE_POSTGRES_MIGRATION !== "true") {
      throw new Error("DATA_BACKEND=postgres is active. Stop the API or set ALLOW_ACTIVE_POSTGRES_MIGRATION=true after ensuring no writers are running.");
    }
  }

  const pool = await createPool();
  try {
    const client = await pool.connect();
    try {
      await assertRequiredTables(client);
      const before = await loadPostgresSnapshot(client);
      const beforeCounts = summarizeSnapshot(before);
      console.log("Current PostgreSQL counts:");
      printCounts(beforeCounts);
      console.log("");

      if (!options.apply) {
        console.log("Dry run complete. PostgreSQL was not modified.");
        console.log("Apply with: npm run postgres:migrate -- --apply --confirm replace-postgres");
        return;
      }

      if (!options.allowNonEmpty && !isPostgresEmpty(before)) {
        throw new Error("PostgreSQL already contains data. Re-run with --allow-non-empty only after creating/confirming a backup.");
      }

      const backupFile = await writePostgresBackup(before, options.backupDir);
      console.log(`Backup of current PostgreSQL snapshot: ${backupFile}`);

      await client.query("begin");
      try {
        await lockSnapshotWrite(client);
        await replacePostgresSnapshot(client, prepared);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }

      const after = await loadPostgresSnapshot(client);
      const afterCounts = summarizeSnapshot(after);
      const expectedCounts = adjustedExpectedCounts(analysis);
      const mismatches = diffCounts(expectedCounts, afterCounts);
      console.log("");
      console.log("PostgreSQL counts after import:");
      printCounts(afterCounts);
      console.log("");

      if (mismatches.length) {
        console.log("Count mismatches:");
        for (const mismatch of mismatches) {
          console.log(`- ${mismatch.table}: expected ${mismatch.expected}, actual ${mismatch.actual}`);
        }
        throw new Error("PostgreSQL import finished but count reconciliation failed.");
      }

      console.log("PostgreSQL import completed and counts reconciled.");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
