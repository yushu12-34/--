import { preparePostgresSnapshot } from "../apps/api/src/services/postgresStore.js";
import {
  analyzePreparedSnapshot,
  defaultDbFile,
  printCounts,
  printIssues,
  readSourceDb,
  shouldBlockMigration,
} from "./postgres-migration-utils.mjs";

const dbFile = defaultDbFile();
const sourceDb = await readSourceDb(dbFile);
const prepared = preparePostgresSnapshot(sourceDb, { timestamp: new Date().toISOString() });
const analysis = analyzePreparedSnapshot(sourceDb, prepared);
const strict = process.env.POSTGRES_DRY_RUN_STRICT === "true";

console.log(`PostgreSQL dry-run source: ${dbFile}`);
console.log("");
console.log("Table counts after adapter normalization:");
printCounts(analysis.counts);

console.log("");
console.log("Breakdowns:");
console.log(`assets by type: ${JSON.stringify(analysis.breakdowns.assetsByType)}`);
console.log(`tasks by status: ${JSON.stringify(analysis.breakdowns.tasksByStatus)}`);
console.log(`models by type: ${JSON.stringify(analysis.breakdowns.modelsByType)}`);

console.log("");
if (analysis.issues.length) {
  printIssues(analysis);
  if (shouldBlockMigration(analysis, { strict })) {
    process.exitCode = 1;
  } else {
    console.log("Set POSTGRES_DRY_RUN_STRICT=true to fail on warnings before a formal migration.");
  }
} else {
  console.log("No blocking warnings found. Dry-run did not write PostgreSQL.");
}
