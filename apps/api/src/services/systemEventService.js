import { updateJson } from "../db.js";
import { id, now } from "../utils/http.js";

const DEFAULT_LIMIT = 100;
const MAX_EVENTS = 500;
const MAX_METADATA_STRING_LENGTH = 500;
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|api[-_]?key|apikey|credential)/i;

function sanitizeMetadataValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === undefined || value === null) return value;
  if (typeof value === "string") {
    return value.length > MAX_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadataValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, nestedValue]) => [
          key,
          SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeMetadataValue(nestedValue, depth + 1),
        ]),
    );
  }
  return String(value);
}

function normalizeLevel(level) {
  return ["info", "warning", "error"].includes(level) ? level : "info";
}

function normalizeCategory(category) {
  return ["system", "api", "security", "task", "model", "backup"].includes(category) ? category : "system";
}

export function appendSystemEvent(db, event, options = {}) {
  const timestamp = event.createdAt || now();
  const nextEvent = {
    id: event.id || id("event"),
    level: normalizeLevel(event.level),
    category: normalizeCategory(event.category),
    source: String(event.source || "api"),
    message: String(event.message || "系统事件"),
    metadata: sanitizeMetadataValue(event.metadata || {}),
    createdAt: timestamp,
  };

  if (!Array.isArray(db.systemEvents)) db.systemEvents = [];
  db.systemEvents.unshift(nextEvent);
  db.systemEvents = db.systemEvents.slice(0, Number(options.maxEvents || MAX_EVENTS));
  return nextEvent;
}

export async function recordSystemEvent(event, options = {}) {
  return updateJson((db) => appendSystemEvent(db, event, options));
}

export function summarizeSystemEvents(events = []) {
  const summary = {
    total: events.length,
    byLevel: { info: 0, warning: 0, error: 0 },
    byCategory: { system: 0, api: 0, security: 0, task: 0, model: 0, backup: 0 },
    latestErrorAt: null,
    latestWarningAt: null,
  };

  for (const event of events) {
    const level = normalizeLevel(event.level);
    const category = normalizeCategory(event.category);
    summary.byLevel[level] += 1;
    summary.byCategory[category] += 1;
    if (level === "error" && !summary.latestErrorAt) summary.latestErrorAt = event.createdAt || null;
    if (level === "warning" && !summary.latestWarningAt) summary.latestWarningAt = event.createdAt || null;
  }

  return summary;
}

export function listSystemEvents(db, filters = {}) {
  const level = filters.level ? normalizeLevel(String(filters.level)) : "";
  const category = filters.category ? normalizeCategory(String(filters.category)) : "";
  const limit = Math.min(Math.max(Number(filters.limit || DEFAULT_LIMIT), 1), MAX_EVENTS);
  const allEvents = Array.isArray(db.systemEvents) ? db.systemEvents : [];
  const events = allEvents
    .filter((event) => !level || event.level === level)
    .filter((event) => !category || event.category === category)
    .slice(0, limit);

  return {
    events,
    summary: summarizeSystemEvents(allEvents),
  };
}
