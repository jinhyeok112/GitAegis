import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getDatabase } from "@/lib/server/db";
import { downloadRepositorySource } from "@/lib/server/github";
import { analyzeArchive, type ScanFinding } from "@/lib/server/scan-engine";
import { ServiceError } from "@/lib/server/errors";

export async function runManualScan(userId: string, repositoryId: string) {
  const db = getDatabase();
  const [repositories] = await db.execute<RowDataPacket[]>("SELECT github_repository_id, connected FROM repositories WHERE id = ? AND user_id = ?", [repositoryId, userId]);
  if (!repositories[0]) throw new ServiceError("REPOSITORY_NOT_FOUND", "저장소를 찾을 수 없습니다.", 404);
  if (!repositories[0].connected) throw new ServiceError("REPOSITORY_DISCONNECTED", "저장소를 먼저 연결해 주세요.", 409);
  const connection = await db.getConnection();
  const lock = `gitaegis:scan:${createHash("sha256").update(process.env.MYSQL_DATABASE || "").digest("hex").slice(0, 24)}`;
  const scanId = randomUUID();
  const workRoot = resolve(process.cwd(), ".tools", "scans");
  let acquired = false;
  let created = false;
  let work: string | undefined;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    if (Number(locks[0].acquired) !== 1) throw new ServiceError("SCANNER_BUSY", "다른 수동 검사가 진행 중입니다. 완료 후 다시 시도해 주세요.", 409);
    acquired = true;
    // A live worker holds the DB lock. Leftover running rows belong to a worker
    // that stopped before finishing, and must not appear to run forever.
    await connection.execute("UPDATE scans SET status = 'failed', error_message = '서버가 재시작되어 검사가 중단되었습니다.', completed_at = UTC_TIMESTAMP(3) WHERE trigger_type = 'manual' AND status IN ('queued', 'running')");
    await connection.execute("INSERT INTO scans (id, repository_id, trigger_type, status, scan_scope, started_at) VALUES (?, ?, 'manual', 'running', 'sast', UTC_TIMESTAMP(3))", [scanId, repositoryId]);
    created = true;
    await mkdir(workRoot, { recursive: true });
    work = await mkdtemp(join(workRoot, "run-"));
    const archive = join(work, "repository.tar.gz");
    const sha = await downloadRepositorySource(userId, String(repositories[0].github_repository_id), archive);
    await connection.execute("UPDATE scans SET commit_sha = ? WHERE id = ?", [sha, scanId]);
    const findings = await analyzeArchive(archive, work);
    await connection.beginTransaction();
    try {
      for (const finding of findings) await saveFinding(connection, repositoryId, scanId, finding);
      await connection.execute("UPDATE scans SET status = 'completed', sast_count = ?, completed_at = UTC_TIMESTAMP(3) WHERE id = ?", [findings.length, scanId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    return { scanId, status: "completed", findings: findings.length, commitSha: sha, scope: "sast" };
  } catch (error) {
    if (created) await connection.execute("UPDATE scans SET status = 'failed', error_message = ?, completed_at = UTC_TIMESTAMP(3) WHERE id = ?", [error instanceof ServiceError ? error.message : "검사를 완료하지 못했습니다. GitHub 연결과 검사 실행기 상태를 확인해 주세요.", scanId]);
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("SCAN_FAILED", "검사를 완료하지 못했습니다. GitHub 연결과 검사 실행기 상태를 확인해 주세요.", 502);
  } finally {
    if (acquired) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]).catch(() => {});
    connection.release();
    // Delete only the temporary directory created by this invocation.
    if (work && dirname(work) === workRoot && work.startsWith(`${workRoot}${sep}run-`)) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function saveFinding(connection: PoolConnection, repositoryId: string, scanId: string, finding: ScanFinding) {
  const fingerprint = createHash("sha256").update([finding.rule, finding.file, String(finding.line), finding.code.trim()].join("\0")).digest("hex");
  const title = `${finding.fixture ? "검사용 샘플 · " : ""}${finding.message}`.slice(0, 500);
  await connection.execute("INSERT INTO vulnerabilities (id, repository_id, fingerprint, source, external_id, title, severity, description, impact, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'sast', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP(3), title = VALUES(title), description = VALUES(description), impact = VALUES(impact), severity = VALUES(severity), status = IF(status = 'resolved', 'open', status), resolved_at = IF(status = 'open', NULL, resolved_at)", [randomUUID(), repositoryId, fingerprint, finding.rule, title, finding.severity, finding.message, finding.impact]);
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM vulnerabilities WHERE repository_id = ? AND fingerprint = ?", [repositoryId, fingerprint]);
  await connection.execute("INSERT INTO scan_findings (id, scan_id, vulnerability_id, file_path, start_line, end_line, code_snippet) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), scanId, rows[0].id, finding.file, finding.line, finding.endLine, finding.code]);
}
