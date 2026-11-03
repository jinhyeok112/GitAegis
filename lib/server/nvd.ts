import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import type { RowDataPacket } from "mysql2";
import { getDatabase } from "@/lib/server/db";
import { object, readSecurityJson } from "@/lib/server/security-http";

export interface NvdEvidence { id: string; description: string; references: string[]; affected: unknown[]; checkedAt: string }
export const NVD_PUBLIC_INTERVAL_MS = 6100; // Five requests per rolling 30 seconds.

export async function getNvdEvidence(id: string): Promise<NvdEvidence | null> {
  if (!/^CVE-\d{4}-\d{4,}$/.test(id)) return null;
  const connection = await getDatabase().getConnection();
  let locked = false;
  try {
    // Shared across workers. The timestamp lives in the application's DB.
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK('gitaegis:nvd-public', 15) AS acquired");
    if (Number(locks[0].acquired) !== 1) throw new Error("NVD queue busy");
    locked = true;
    const [cache] = await connection.execute<RowDataPacket[]>("SELECT payload, checked_at FROM security_api_cache WHERE cache_key = ? AND checked_at > UTC_TIMESTAMP(3) - INTERVAL 1 DAY", [`nvd:${id}`]);
    if (cache.length) return (typeof cache[0].payload === "string" ? JSON.parse(cache[0].payload) : cache[0].payload) as NvdEvidence | null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const [clock] = await connection.execute<RowDataPacket[]>("SELECT TIMESTAMPDIFF(MICROSECOND, checked_at, UTC_TIMESTAMP(3)) / 1000 AS elapsed FROM security_api_cache WHERE cache_key = 'nvd:last-request'");
      if (clock.length) await delay(Math.max(0, NVD_PUBLIC_INTERVAL_MS - Number(clock[0].elapsed)));
      await connection.execute("INSERT INTO security_api_cache (cache_key, payload, checked_at) VALUES ('nvd:last-request', NULL, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE checked_at = UTC_TIMESTAMP(3)");
      const response = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${id}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } });
      if ((response.status === 403 || response.status === 429) && attempt === 0) {
        const retry = response.headers.get("retry-after");
        const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 30000;
        await response.body?.cancel();
        if (!Number.isFinite(retryMs) || retryMs > 30000) throw new Error("NVD rate limited");
        await delay(Math.max(NVD_PUBLIC_INTERVAL_MS, retryMs));
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("NVD unavailable"); }
      const data = object(await readSecurityJson(response));
      if (!Array.isArray(data.vulnerabilities)) throw new Error("Invalid NVD response");
      const entry = data.vulnerabilities.map(value => object(object(value).cve)).find(cve => cve.id === id);
      const result: NvdEvidence | null = entry ? {
        id, description: Array.isArray(entry.descriptions) ? entry.descriptions.map(object).filter(item => item.lang === "en").map(item => String(item.value)).join("\n").slice(0, 12000) : "",
        references: Array.isArray(entry.references) ? entry.references.map(object).map(item => String(item.url)).filter(url => /^https:\/\//.test(url)).slice(0, 20) : [],
        affected: Array.isArray(entry.affected) ? entry.affected : [], checkedAt: new Date().toISOString(),
      } : null;
      await connection.execute("INSERT INTO security_api_cache (cache_key, payload, checked_at) VALUES (?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE payload = VALUES(payload), checked_at = UTC_TIMESTAMP(3)", [`nvd:${id}`, JSON.stringify(result)]);
      return result;
    }
    return null;
  } finally {
    if (locked) await connection.execute("SELECT RELEASE_LOCK('gitaegis:nvd-public')").catch(() => {});
    connection.release();
  }
}
