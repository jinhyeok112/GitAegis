import "server-only";
import type { UpgradeAssessment } from "@/lib/types";
import { compareVersions, getAdvisory, npmName, queryVersions, stableVersion, type Advisory, type PackageVersion } from "@/lib/server/osv";
import { getNvdEvidence, type NvdEvidence } from "@/lib/server/nvd";
import { object, securityJson } from "@/lib/server/security-http";

export function advisoryFixedVersions(advisory: Advisory, pkg: PackageVersion) {
  if (!stableVersion.test(pkg.version)) return [];
  return [...new Set((advisory.affected ?? []).filter(item => item.package?.name === pkg.name && item.package.ecosystem === pkg.ecosystem).flatMap(item => (item.ranges ?? []).filter(range => range.type === "SEMVER" || range.type === "ECOSYSTEM").flatMap(range => range.events.map(event => event.fixed).filter((version): version is string => typeof version === "string" && stableVersion.test(version) && compareVersions(version, pkg.version) > 0))))].sort(compareVersions);
}

type InferVersion = (evidence: { package: PackageVersion; advisories: Advisory[]; nvd: NvdEvidence | null }) => Promise<{ version: string | null; reason: string }>;

export async function assessUpgrade(pkg: PackageVersion, advisoryId: string, infer?: InferVersion): Promise<UpgradeAssessment> {
  const result: UpgradeAssessment = { status: "unverified", recommendedVersion: null, checkedAt: new Date().toISOString(), checkedVersions: 0, knownAdvisoryIds: [], skippedVersions: [], publishedFixedVersions: [], aiCandidateVersion: null, aiReason: null, nvdStatus: "no_cve", sources: ["https://osv.dev/"], explanation: "업데이트 대상 버전을 확인하지 못했습니다.", majorUpdate: false };
  if (pkg.ecosystem !== "npm" || !npmName.test(pkg.name) || !stableVersion.test(pkg.version)) {
    result.explanation = "현재 최소 버전 검증은 npm의 정식 x.y.z 버전을 지원합니다. 이 패키지는 별도 확인이 필요합니다.";
    return result;
  }
  try {
    const [current] = await queryVersions([pkg]);
    const advisories = (await Promise.all(current.map(getAdvisory))).filter(item => !item.withdrawn);
    result.knownAdvisoryIds = advisories.map(item => item.id);
    if (!advisories.some(item => item.id === advisoryId || item.aliases?.includes(advisoryId))) {
      result.explanation = "최신 조회에서 기존 보안 공지와 현재 버전의 영향 관계를 확인하지 못했습니다. 공지 변경·철회 여부를 확인하세요.";
      return result;
    }
    result.publishedFixedVersions = [...new Set(advisories.flatMap(item => advisoryFixedVersions(item, pkg)))].sort(compareVersions);
    result.sources.push(...advisories.map(item => `https://osv.dev/vulnerability/${encodeURIComponent(item.id)}`));
    const target = advisories.find(item => item.id === advisoryId || item.aliases?.includes(advisoryId))!;
    const cve = [target.id, ...(target.aliases ?? [])].find(id => /^CVE-\d{4}-\d{4,}$/.test(id));
    let nvd: NvdEvidence | null = null;
    if (cve) {
      result.sources.push(`https://nvd.nist.gov/vuln/detail/${cve}`);
      try { nvd = await getNvdEvidence(cve); } catch { /* OSV checks remain useful, and the missing enrichment is explicit. */ }
      result.nvdStatus = nvd ? "available" : "unavailable";
    }
    if (!advisoryFixedVersions(target, pkg).length && infer) {
      try {
        const suggestion = await infer({ package: pkg, advisories, nvd });
        result.aiCandidateVersion = suggestion.version && stableVersion.test(suggestion.version) ? suggestion.version : null;
        result.aiReason = suggestion.reason.slice(0, 2000);
      } catch { result.aiReason = "AI에서 근거 있는 수정 버전을 추출하지 못했습니다."; }
    }
    const registry = object(await securityJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, { headers: { Accept: "application/vnd.npm.install-v1+json" } }));
    if (registry.name !== pkg.name) throw new Error("Registry package identity mismatch");
    const versions = object(registry.versions);
    const candidates = Object.keys(versions).filter(version => stableVersion.test(version) && compareVersions(version, pkg.version) > 0 && !object(versions[version]).deprecated).sort(compareVersions);
    result.sources.push(`https://www.npmjs.com/package/${pkg.name}?activeTab=versions`);
    // Evaluate every earlier eligible release; a later AI guess cannot skip a
    // smaller safe release or bypass the same exact-version vulnerability query.
    for (let start = 0; start < Math.min(candidates.length, 1000); start += 100) {
      const chunk = candidates.slice(start, Math.min(start + 100, 1000));
      const matches = await queryVersions(chunk.map(version => ({ ...pkg, version })));
      for (let i = 0; i < chunk.length; i++) {
        result.checkedVersions++;
        if (matches[i].length) {
          if (result.skippedVersions.length < 20) result.skippedVersions.push({ version: chunk[i], advisoryIds: matches[i] });
          continue;
        }
        result.status = "verified";
        result.recommendedVersion = chunk[i];
        result.majorUpdate = chunk[i].split(".")[0] !== pkg.version.split(".")[0];
        result.explanation = "설치 버전보다 높은 비권장 처리되지 않은 정식 배포 버전을 오름차순으로 조회한 결과, OSV에 등록된 알려진 취약점이 처음으로 발견되지 않은 버전입니다. 이 버전 하나를 확인한 결과이며 이후의 모든 버전이나 전이 의존성·실행 호환성을 보장하지 않습니다.";
        return result;
      }
    }
    result.status = candidates.length > 1000 ? "unverified" : "no_candidate";
    result.explanation = candidates.length > 1000 ? "앞선 1,000개 후보에서 취약점이 발견되어 검증 한도에 도달했습니다. 안전한 업데이트 버전을 확정하지 않았습니다." : "현재 등록된 정식 업데이트 후보 중 알려진 취약점이 발견되지 않는 버전을 찾지 못했습니다. 대체 패키지나 공급자 대응을 확인하세요.";
  } catch { result.status = "unverified"; result.recommendedVersion = null; result.explanation = "배포 버전 또는 취약점 조회를 완료하지 못했습니다. 조회 실패를 안전하다는 결과로 처리하지 않았습니다."; }
  return result;
}
