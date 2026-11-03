import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Severity } from "@/lib/types";
import { getAdvisory, npmName, queryVersions, type Advisory, type PackageVersion } from "@/lib/server/osv";
import { object } from "@/lib/server/security-http";
import { ServiceError } from "@/lib/server/errors";

export interface DependencyFinding {
  file: string; packageName: string; ecosystem: string; installedVersion: string;
  advisory: Advisory; severity: Severity; score: number | null;
}

export function lockPackages(value: unknown): PackageVersion[] {
  const lock = object(value);
  if (![2, 3].includes(Number(lock.lockfileVersion))) throw new Error("Only npm lockfile v2/v3 is supported");
  const packages = object(lock.packages);
  const found = new Map<string, PackageVersion>();
  for (const [path, raw] of Object.entries(packages)) {
    if (!path || !path.includes("node_modules/")) continue;
    const item = object(raw);
    if (item.link === true) continue;
    const name = typeof item.name === "string" ? item.name : path.slice(path.lastIndexOf("node_modules/") + 13);
    if (!npmName.test(name) || name.length > 214 || typeof item.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(item.version)) throw new Error("Unresolved package version");
    // Aliases identify the actual registry package through its name. Git/file
    // dependencies cannot be verified against the npm registry by version alone.
    if (typeof item.resolved === "string" && !item.resolved.startsWith("https://registry.npmjs.org/")) throw new Error("Non-registry dependency requires separate verification");
    found.set(`${name}@${item.version}`, { name, ecosystem: "npm", version: item.version });
  }
  if (found.size > 2000) throw new Error("Too many dependencies");
  return [...found.values()];
}

export async function scanDependencies(source: string): Promise<{ findings: DependencyFinding[]; checked: boolean }> {
  const locks: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name === "package-lock.json" || entry.name === "npm-shrinkwrap.json") locks.push(file);
    }
  }
  await walk(source);
  if (!locks.length) return { findings: [], checked: false };
  if (locks.length > 20) throw new ServiceError("DEPENDENCY_LIMIT", "의존성 파일 수가 검사 한도를 초과했습니다.", 422);
  const findings: DependencyFinding[] = [];
  const advisoryCache = new Map<string, Advisory>();
  try {
    for (const file of locks) {
      if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error("Lockfile exceeds limit");
      const packages = lockPackages(JSON.parse(await readFile(file, "utf8")));
      const matches = await queryVersions(packages);
      for (let i = 0; i < packages.length; i++) for (const id of matches[i]) {
        if (!advisoryCache.has(id)) advisoryCache.set(id, await getAdvisory(id));
        const advisory = advisoryCache.get(id)!;
        if (advisory.withdrawn) continue;
        const level = advisory.database_specific?.severity?.toLowerCase();
        const severity: Severity = level === "critical" || level === "high" || level === "medium" || level === "low" ? level : "info";
        const scores = [advisory.database_specific?.cvss?.score, ...(advisory.severity ?? []).filter(item => /^\d+(\.\d+)?$/.test(item.score)).map(item => Number(item.score))].filter((score): score is number => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10);
        findings.push({ file: relative(source, file).split(sep).join("/"), packageName: packages[i].name, ecosystem: "npm", installedVersion: packages[i].version, advisory, severity, score: scores.length ? Math.max(...scores) : null });
        if (findings.length > 1000) throw new Error("Too many dependency findings");
      }
    }
    return { findings, checked: true };
  } catch { throw new ServiceError("DEPENDENCY_SCAN_INCOMPLETE", "npm 의존성의 버전·취약점 조회를 완료하지 못했습니다. 부분 결과를 완료된 검사로 저장하지 않았습니다.", 502); }
}
