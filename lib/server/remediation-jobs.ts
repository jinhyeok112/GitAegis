import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getDatabase, isDatabaseConfigured } from "@/lib/server/db";
import { loadAiSelection } from "@/lib/server/ai-settings";
import { createRemediation, parseStoredJson } from "@/lib/server/remediation";
import { ServiceError } from "@/lib/server/errors";
import { PREGENERATE_SCORE, shouldPregenerate } from "@/lib/remediation-policy";

export async function enqueueScanRemediations(connection: PoolConnection, userId: string, scanId: string) {
  const selection = await loadAiSelection(userId, connection);
  // No item-count cap: every eligible finding is queued. Generation is serial.
  await connection.execute(`INSERT IGNORE INTO remediation_jobs (id, finding_id, user_id, provider, model_id, priority)
    SELECT UUID(), f.id, ?, ?, ?, 10 FROM scan_findings f JOIN vulnerabilities v ON v.id = f.vulnerability_id
    LEFT JOIN finding_remediations m ON m.finding_id = f.id
    WHERE f.scan_id = ? AND v.status IN ('open', 'triaging')
      AND (v.severity_score >= ? OR (v.severity_score IS NULL AND v.severity IN ('high', 'critical')))
      AND (f.code_snippet IS NOT NULL OR v.source = 'dependency')
      AND m.ai_suggestion IS NULL AND m.dependency_assessment IS NULL`, [userId, selection.provider, selection.model, scanId, PREGENERATE_SCORE]);
}

async function findingFor(userId: string, vulnerabilityId: string) {
  const [rows] = await getDatabase().execute<RowDataPacket[]>(`SELECT f.*, v.source, m.ai_suggestion, m.dependency_assessment
    FROM vulnerabilities v JOIN repositories r ON r.id = v.repository_id
    JOIN scan_findings f ON f.id = (SELECT f2.id FROM scan_findings f2 WHERE f2.vulnerability_id = v.id ORDER BY f2.created_at DESC, f2.id DESC LIMIT 1)
    LEFT JOIN finding_remediations m ON m.finding_id = f.id WHERE v.id = ? AND r.user_id = ?`, [vulnerabilityId, userId]);
  if (!rows[0]) throw new ServiceError("VULNERABILITY_NOT_FOUND", "취약점 정보를 찾을 수 없습니다.", 404);
  return rows[0];
}

function savedResult(row: RowDataPacket) {
  return { ...(row.ai_suggestion ? { suggestion: parseStoredJson(row.ai_suggestion) } : {}), ...(row.dependency_assessment ? { assessment: parseStoredJson(row.dependency_assessment) } : {}) };
}

export async function remediationState(userId: string, vulnerabilityId: string) {
  const row = await findingFor(userId, vulnerabilityId);
  const [jobs] = await getDatabase().execute<RowDataPacket[]>("SELECT status, error_message FROM remediation_jobs WHERE finding_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1", [row.id]);
  return { ...savedResult(row), state: jobs[0]?.status ?? (row.ai_suggestion || row.dependency_assessment ? "completed" : "idle"), error: jobs[0]?.error_message ?? null };
}

export async function requestRemediationJob(userId: string, vulnerabilityId: string, regenerate = false, retry = false) {
  const row = await findingFor(userId, vulnerabilityId);
  const saved = savedResult(row);
  if (!regenerate && (saved.suggestion || saved.assessment)) return { ...saved, state: "completed", error: null };
  if (row.source === "sast" && (!row.code_snippet || !row.file_path)) throw new ServiceError("MISSING_CODE_EVIDENCE", "Semgrep이 탐지한 코드와 위치 정보가 필요합니다.", 422);
  const selection = await loadAiSelection(userId);
  await getDatabase().execute(`INSERT INTO remediation_jobs (id, finding_id, user_id, provider, model_id, priority) VALUES (?, ?, ?, ?, ?, 20)
    ON DUPLICATE KEY UPDATE priority = 20,
      attempts = IF(? AND status IN ('failed', 'completed'), 0, attempts),
      status = IF((? AND status = 'failed') OR (? AND status = 'completed'), 'queued', status),
      error_message = IF(? AND status = 'queued', NULL, error_message)`, [randomUUID(), row.id, userId, selection.provider, selection.model, retry || regenerate, retry, regenerate, retry || regenerate]);
  return remediationState(userId, vulnerabilityId);
}

// A persistent Node server consumes durable DB jobs independently of browsers.
// Holding this DB lock also lets another server safely resume interrupted jobs.
export async function processNextRemediation() {
  const connection = await getDatabase().getConnection();
  const lock = `gitaegis:fix-worker:${createHash("sha256").update(process.env.MYSQL_DATABASE || "").digest("hex").slice(0, 24)}`;
  let acquired = false;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    if (Number(locks[0]?.acquired) !== 1) return;
    acquired = true;
    const [pace] = await connection.execute<RowDataPacket[]>("SELECT TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), checked_at) / 1000 AS remaining FROM security_api_cache WHERE cache_key = 'remediation:next-dispatch'");
    if (Number(pace[0]?.remaining ?? 0) > 0) return;
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT j.*, f.vulnerability_id, v.status AS vulnerability_status, v.severity, v.severity_score FROM remediation_jobs j
      JOIN scan_findings f ON f.id = j.finding_id JOIN vulnerabilities v ON v.id = f.vulnerability_id
      WHERE j.status IN ('queued', 'running') ORDER BY j.priority DESC, j.created_at, j.id LIMIT 1`);
    const job = rows[0];
    if (!job) return;
    if (Number(job.attempts) >= 3 || !["open", "triaging"].includes(job.vulnerability_status) || (Number(job.priority) < 20 && !shouldPregenerate(job.severity, job.severity_score == null ? null : Number(job.severity_score), job.vulnerability_status))) {
      await connection.execute("UPDATE remediation_jobs SET status = 'failed', error_message = ? WHERE id = ?", ["자동 생성을 중단했습니다. 필요하면 세부정보에서 다시 시도해 주세요.", job.id]);
      return;
    }
    await connection.execute("UPDATE remediation_jobs SET status = 'running', attempts = attempts + 1, error_message = NULL WHERE id = ?", [job.id]);
    let pause = 3500;
    try {
      await createRemediation(String(job.user_id), String(job.vulnerability_id), { findingId: String(job.finding_id), selection: { provider: job.provider, model: String(job.model_id) } });
      await connection.execute("UPDATE remediation_jobs SET status = 'completed', error_message = NULL WHERE id = ?", [job.id]);
    } catch (error) {
      const message = error instanceof ServiceError ? error.message : "수정안을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      await connection.execute("UPDATE remediation_jobs SET status = 'failed', error_message = ? WHERE id = ?", [message.slice(0, 1000), job.id]);
      pause = 60000;
    }
    await connection.execute("INSERT INTO security_api_cache (cache_key, checked_at) VALUES ('remediation:next-dispatch', TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3))) ON DUPLICATE KEY UPDATE checked_at = VALUES(checked_at)", [pause * 1000]);
  } finally {
    if (acquired) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]).catch(() => {});
    connection.release();
  }
}

const workerGlobal = globalThis as typeof globalThis & { gitAegisRemediationWorker?: boolean };
export function startRemediationWorker() {
  if (workerGlobal.gitAegisRemediationWorker || !isDatabaseConfigured()) return;
  workerGlobal.gitAegisRemediationWorker = true;
  async function tick() {
    try { await processNextRemediation(); }
    catch { console.error("Remediation worker unavailable; queued jobs retained. Check database readiness."); }
    finally { setTimeout(() => void tick(), 1000).unref(); }
  }
  setTimeout(() => void tick(), 1000).unref();
}
