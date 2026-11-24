import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getDatabase } from "@/lib/server/db";
import { downloadRepositorySource } from "@/lib/server/github";
import { analyzeArchive, type ScanFinding } from "@/lib/server/scan-engine";
import type { DependencyFinding } from "@/lib/server/dependency-scan";
import { advisoryFixedVersions } from "@/lib/server/upgrade-assessment";
import { ServiceError } from "@/lib/server/errors";
import { enqueueScanRemediations } from "@/lib/server/remediation-jobs";
import { remediationEvidenceKey } from "@/lib/server/remediation-evidence";
import { dependencyFindingTitle } from "@/lib/finding-titles.mjs";

export async function runManualScan(userId: string, repositoryId: string) {
  const [repositories] = await getDatabase().execute<RowDataPacket[]>("SELECT github_repository_id, connected FROM repositories WHERE id = ? AND user_id = ?", [repositoryId, userId]);
  if (!repositories[0]) throw new ServiceError("REPOSITORY_NOT_FOUND", "저장소를 찾을 수 없습니다.", 404);
  if (!repositories[0].connected) throw new ServiceError("REPOSITORY_DISCONNECTED", "저장소를 먼저 연결해 주세요.", 409);
  return withScanner(async connection => {
    const scanId = randomUUID();
    await connection.execute("INSERT INTO scans (id, repository_id, trigger_type, status, scan_scope, started_at) VALUES (?, ?, 'manual', 'running', 'sast', UTC_TIMESTAMP(3))", [scanId, repositoryId]);
    return executeScan(connection, scanId, repositoryId, userId, String(repositories[0].github_repository_id));
  });
}

export async function runNextAutomaticScan() {
  return withScanner(async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT s.id, s.repository_id, s.commit_sha, r.user_id, r.github_repository_id
      FROM scans s JOIN repositories r ON r.id = s.repository_id
      WHERE s.status = 'queued' AND s.trigger_type IN ('push', 'schedule')
      ORDER BY s.created_at, s.id LIMIT 1`);
    const scan = rows[0];
    if (!scan) return;

    const [claimed] = await connection.execute<ResultSetHeader>(`UPDATE scans s JOIN repositories r ON r.id = s.repository_id
      SET s.status = 'running', s.scan_scope = 'sast', s.started_at = UTC_TIMESTAMP(3)
      WHERE s.id = ? AND s.status = 'queued' AND r.connected = TRUE
      AND ((s.trigger_type = 'push' AND r.scan_on_push = TRUE) OR (s.trigger_type = 'schedule' AND r.scheduled_scan_enabled = TRUE))`, [scan.id]);
    if (!claimed.affectedRows) {
      await connection.execute("UPDATE scans SET status = 'canceled', completed_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'queued'", [scan.id]);
      return;
    }
    await executeScan(connection, String(scan.id), String(scan.repository_id), String(scan.user_id), String(scan.github_repository_id), scan.commit_sha ?? undefined);
  });
}

async function withScanner<T>(run: (connection: PoolConnection) => Promise<T>) {
  const connection = await getDatabase().getConnection();
  const lock = `gitaegis:scan:${createHash("sha256").update(process.env.MYSQL_DATABASE || "").digest("hex").slice(0, 24)}`;
  let acquired = false;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    if (Number(locks[0].acquired) !== 1) throw new ServiceError("SCANNER_BUSY", "다른 검사가 진행 중입니다. 완료 후 다시 시도해 주세요.", 409);
    acquired = true;
    // Any running row left after taking the lock belongs to an interrupted scan.
    await connection.execute("UPDATE scans SET status = 'failed', error_message = '서버가 재시작되어 검사가 중단되었습니다.', completed_at = UTC_TIMESTAMP(3) WHERE status = 'running' OR (trigger_type = 'manual' AND status = 'queued')");
    return await run(connection);
  } finally {
    if (acquired) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]).catch(() => {});
    connection.release();
  }
}

async function executeScan(connection: PoolConnection, scanId: string, repositoryId: string, userId: string, githubId: string, pushedSha?: string) {
  const workRoot = resolve(process.cwd(), ".tools", "scans");
  let work: string | undefined;
  try {
    await mkdir(workRoot, { recursive: true });
    work = await mkdtemp(join(workRoot, "run-"));
    const archive = join(work, "repository.tar.gz");
    const sha = await downloadRepositorySource(userId, githubId, archive, pushedSha);
    await connection.execute("UPDATE scans SET commit_sha = ? WHERE id = ?", [sha, scanId]);
    const { findings, dependencies } = await analyzeArchive(archive, work);
    const scope = dependencies.checked ? "sast_dependency" : "sast";
    await connection.beginTransaction();
    try {
      for (const finding of findings) await saveFinding(connection, repositoryId, scanId, finding);
      for (const finding of dependencies.findings) await saveDependencyFinding(connection, repositoryId, scanId, finding);
      await enqueueScanRemediations(connection, userId, scanId);
      await connection.execute("UPDATE scans SET status = 'completed', sast_count = ?, dependency_count = ?, scan_scope = ?, completed_at = UTC_TIMESTAMP(3) WHERE id = ?", [findings.length, dependencies.findings.length, scope, scanId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    return { scanId, status: "completed", findings: findings.length + dependencies.findings.length, sastCount: findings.length, dependencyCount: dependencies.findings.length, commitSha: sha, scope };
  } catch (error) {
    await connection.execute("UPDATE scans SET status = 'failed', error_message = ?, completed_at = UTC_TIMESTAMP(3) WHERE id = ?", [error instanceof ServiceError ? error.message : "검사를 완료하지 못했습니다. GitHub 연결과 검사 실행기 상태를 확인해 주세요.", scanId]);
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("SCAN_FAILED", "검사를 완료하지 못했습니다. GitHub 연결과 검사 실행기 상태를 확인해 주세요.", 502);
  } finally {
    // Delete only the temporary directory created by this invocation.
    if (work && dirname(work) === workRoot && work.startsWith(`${workRoot}${sep}run-`)) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function saveDependencyFinding(connection: PoolConnection, repositoryId: string, scanId: string, finding: DependencyFinding) {
  const { advisory, packageName, ecosystem, installedVersion, file } = finding;
  const fingerprint = createHash("sha256").update(["dependency", file, packageName, installedVersion, advisory.id].join("\0")).digest("hex");
  const title = dependencyFindingTitle(packageName, installedVersion, advisory.summary || advisory.id);
  const cve = advisory.aliases?.find(id => /^CVE-\d{4}-\d{4,}$/.test(id));
  const url = cve ? `https://nvd.nist.gov/vuln/detail/${cve}` : `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}`;
  const fixed = advisoryFixedVersions(advisory, { name: packageName, ecosystem, version: installedVersion });
  await connection.execute("INSERT INTO vulnerabilities (id, repository_id, fingerprint, source, external_id, title, severity, description, impact, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'dependency', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP(3), title = VALUES(title), description = VALUES(description), severity = VALUES(severity)", [randomUUID(), repositoryId, fingerprint, advisory.id, title, finding.severity, (advisory.details || advisory.summary || advisory.id).slice(0, 12000), "설치된 패키지 버전이 공개 보안 공지의 영향 대상입니다. 실제 사용 경로와 업데이트 호환성을 확인하세요."]);
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM vulnerabilities WHERE repository_id = ? AND fingerprint = ?", [repositoryId, fingerprint]);
  await connection.execute("UPDATE vulnerabilities SET severity_score = ? WHERE id = ?", [finding.score, rows[0].id]);
  await connection.execute("INSERT INTO scan_findings (id, scan_id, vulnerability_id, file_path, dependency_name, dependency_ecosystem, installed_version, affected_version_range, fixed_version, advisory_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), scanId, rows[0].id, file, packageName, ecosystem, installedVersion, `OSV 조회에서 ${installedVersion} 영향 확인 (${advisory.id})`, fixed[0] ?? null, url]);
}

async function saveFinding(connection: PoolConnection, repositoryId: string, scanId: string, finding: ScanFinding) {
  const fingerprint = createHash("sha256").update([finding.rule, finding.file, String(finding.line), finding.code.trim()].join("\0")).digest("hex");
  const title = finding.message.slice(0, 500);
  await connection.execute("INSERT INTO vulnerabilities (id, repository_id, fingerprint, source, external_id, title, severity, description, impact, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'sast', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP(3), title = VALUES(title), description = VALUES(description), impact = VALUES(impact), severity = VALUES(severity), status = IF(status = 'resolved', 'open', status), resolved_at = IF(status = 'open', NULL, resolved_at)", [randomUUID(), repositoryId, fingerprint, finding.rule, title, finding.severity, finding.description, finding.impact]);
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM vulnerabilities WHERE repository_id = ? AND fingerprint = ?", [repositoryId, fingerprint]);
  await connection.execute("UPDATE vulnerabilities SET severity_score = ?, description_source = ? WHERE id = ?", [finding.score, finding.descriptionSource, rows[0].id]);
  const findingId = randomUUID();
  const evidenceKey = remediationEvidenceKey({ rule: finding.rule, description: finding.description, impact: finding.impact, filePath: finding.file, code: finding.codeContext || finding.code, startLine: finding.codeContext ? finding.contextStartLine : finding.line });
  await connection.execute("INSERT INTO scan_findings (id, scan_id, vulnerability_id, file_path, start_line, end_line, code_snippet, code_context, context_start_line, context_end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [findingId, scanId, rows[0].id, finding.file, finding.line, finding.endLine, finding.code, finding.codeContext || null, finding.contextStartLine, finding.contextEndLine]);
  // Same vulnerability and exact context can reuse an earlier successful fix.
  await connection.execute(`INSERT INTO finding_remediations (finding_id, ai_suggestion, checked_at)
    SELECT ?, m.ai_suggestion, m.checked_at FROM scan_findings f JOIN finding_remediations m ON m.finding_id = f.id
    WHERE f.vulnerability_id = ? AND f.id <> ? AND f.code_snippet = ? AND f.code_context <=> ? AND JSON_UNQUOTE(JSON_EXTRACT(m.ai_suggestion, '$.evidenceKey')) = ?
    ORDER BY f.created_at DESC, f.id DESC LIMIT 1`, [findingId, rows[0].id, findingId, finding.code, finding.codeContext || null, evidenceKey]);
}
