import { createRequire } from "node:module";

export async function loadPgDriver() {
  try {
    return await import("pg");
  } catch (rootError) {
    try {
      const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
      return apiRequire("pg");
    } catch (apiError) {
      const rootMessage = rootError instanceof Error ? rootError.message : String(rootError);
      const apiMessage = apiError instanceof Error ? apiError.message : String(apiError);
      throw new Error(`PostgreSQL driver is not installed. Root import failed: ${rootMessage}. API dependency fallback failed: ${apiMessage}`);
    }
  }
}

export function getPoolCtor(pg) {
  return pg.Pool || pg.default?.Pool;
}
