import "server-only";
import { object, securityJson } from "@/lib/server/security-http";

export interface PackageVersion { name: string; ecosystem: string; version: string }
export interface Advisory {
  id: string; summary?: string; details?: string; withdrawn?: string; aliases?: string[];
  references?: { type: string; url: string }[];
  database_specific?: { severity?: string; cvss?: { score?: number } };
  severity?: { type: string; score: string }[];
  affected?: { package?: { name: string; ecosystem: string }; versions?: string[]; ranges?: { type: string; events: { introduced?: string; fixed?: string; last_affected?: string; limit?: string }[] }[] }[];
}

export async function queryVersions(packages: PackageVersion[]) {
  const results: string[][] = packages.map(() => []);
  for (let start = 0; start < packages.length; start += 100) {
    let pending = packages.slice(start, start + 100).map((pkg, index) => ({ index: start + index, query: { package: { name: pkg.name, ecosystem: pkg.ecosystem }, version: pkg.version, page_token: "" } }));
    const seenTokens = new Set<string>();
    for (let page = 0; pending.length; page++) {
      if (page >= 20) throw new Error("OSV pagination exceeds limit");
      const data = object(await securityJson("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: pending.map(item => item.query) }) }));
      if (!Array.isArray(data.results) || data.results.length !== pending.length) throw new Error("Incomplete OSV response");
      const next: typeof pending = [];
      for (let index = 0; index < pending.length; index++) {
        const row = object(data.results[index]);
        if (row.error) throw new Error("OSV query failed");
        if (row.vulns !== undefined && !Array.isArray(row.vulns)) throw new Error("Invalid OSV vulnerabilities");
        for (const item of (row.vulns ?? []) as unknown[]) {
          const id = object(item).id;
          if (typeof id !== "string" || !/^[A-Za-z0-9:_.-]{1,191}$/.test(id)) throw new Error("Invalid advisory id");
          results[pending[index].index].push(id);
        }
        if (row.next_page_token !== undefined && typeof row.next_page_token !== "string") throw new Error("Invalid OSV pagination");
        if (row.next_page_token) {
          const key = `${pending[index].index}:${row.next_page_token}`;
          if (seenTokens.has(key)) throw new Error("Repeated OSV pagination");
          seenTokens.add(key);
          next.push({ ...pending[index], query: { ...pending[index].query, page_token: row.next_page_token as string } });
        }
      }
      pending = next;
    }
  }
  return results.map(ids => [...new Set(ids)]);
}

export async function getAdvisory(id: string): Promise<Advisory> {
  if (!/^[A-Za-z0-9:_.-]{1,191}$/.test(id)) throw new Error("Invalid advisory id");
  const data = object(await securityJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`));
  if (data.id !== id || (data.affected !== undefined && !Array.isArray(data.affected))) throw new Error("Invalid advisory response");
  return data as unknown as Advisory;
}

export const npmName = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(a: string, b: string) {
  if (!stableVersion.test(a) || !stableVersion.test(b)) throw new Error("Unsupported version ordering");
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
