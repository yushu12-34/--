import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const envFile = resolve(rootDir, ".env");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex < 0) return null;
  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (!key) return null;
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

try {
  const content = readFileSync(envFile, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (process.env.DATA_DIR && !isAbsolute(process.env.DATA_DIR)) {
  process.env.DATA_DIR = resolve(rootDir, process.env.DATA_DIR);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-with-root-env.mjs <command> [...args]");
  process.exit(1);
}

function shouldUseCmd(commandName) {
  if (process.platform !== "win32") return false;
  const lower = commandName.toLowerCase();
  return /\.(cmd|bat)$/i.test(lower) || ["npm", "npx", "pnpm", "yarn"].includes(lower);
}

function quoteCmdArg(value) {
  if (value === "") return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

const child = shouldUseCmd(command)
  ? spawn("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")], {
    cwd: rootDir,
    env: process.env,
    shell: false,
    stdio: "inherit",
  })
  : spawn(command, args, {
  cwd: rootDir,
  env: process.env,
  shell: false,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
