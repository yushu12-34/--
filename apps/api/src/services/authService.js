import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const PASSWORD_KEY_LENGTH = 64;
const TOKEN_BYTES = 32;

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(String(password || ""), salt, PASSWORD_KEY_LENGTH);
  return `scrypt:${salt}:${Buffer.from(key).toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  const [scheme, salt, expected] = String(storedHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const key = await scrypt(String(password || ""), salt, PASSWORD_KEY_LENGTH);
  return timingSafeEqualText(Buffer.from(key).toString("hex"), expected);
}

export function createSessionToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function publicUser(user = {}) {
  const { passwordHash, password_hash, tokenHash, token_hash, ...safeUser } = user;
  return safeUser;
}
