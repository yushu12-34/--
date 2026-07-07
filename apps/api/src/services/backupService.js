import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const DEFAULT_DB_FILE = path.join(DEFAULT_DATA_DIR, "db.json");
const DEFAULT_BACKUP_DIR = path.join(DEFAULT_DATA_DIR, "backups");

function sanitizeOperation(operation) {
  return String(operation || "manual")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "manual";
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function createDbBackup(operation, options = {}) {
  const backend = String(process.env.DATA_BACKEND || "json").toLowerCase();
  if (backend === "postgres" || backend === "postgresql") {
    return {
      operation: sanitizeOperation(operation),
      file: null,
      storage: "postgres",
      skipped: true,
      createdAt: (options.now || new Date()).toISOString(),
    };
  }
  const dbFile = options.dbFile || DEFAULT_DB_FILE;
  const backupDir = options.backupDir || DEFAULT_BACKUP_DIR;
  const safeOperation = sanitizeOperation(operation);
  await stat(dbFile);
  await mkdir(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${timestampForFilename(options.now)}_${safeOperation}.db.json`);
  await copyFile(dbFile, backupFile);
  return {
    operation: safeOperation,
    file: backupFile,
    createdAt: (options.now || new Date()).toISOString(),
  };
}

export async function createRequiredDbBackup(operation, options = {}) {
  try {
    return await createDbBackup(operation, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`数据备份失败，已阻止危险写入：${message}`);
    wrapped.cause = error;
    wrapped.code = "DB_BACKUP_FAILED";
    wrapped.operation = operation;
    throw wrapped;
  }
}
