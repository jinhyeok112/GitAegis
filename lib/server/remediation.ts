import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import type { AiModelSelection, Vulnerability } from "@/lib/types";
import { getDatabase } from "@/lib/server/db";
import { ServiceError } from "@/lib/server/errors";
import { aiText } from "@/lib/server/ai-json";
import type { AiUsage } from "@/lib/server/openrouter";
import { generateAiJson } from "@/lib/server/ai-generation";
import { aiProviderConfigured, loadAiSelection } from "@/lib/server/ai-settings";
import { aiSelectionKey } from "@/lib/ai-models";
import { assessUpgrade } from "@/lib/server/upgrade-assessment";
import { remediationEvidenceKey } from "@/lib/server/remediation-evidence";

export function parseStoredJson(value: unknown) { return typeof value === "string" ? JSON.parse(value) : value; }

export async function createRemediation(userId: string, vulnerabilityId: string, job?: { findingId: string; selection: AiModelSelection }) {
  const db = getDatabase();
  const connection = await db.getConnection();
  const lock = `gitaegis:remediation:${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
  let locked = false;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    if (Number(locks[0].acquired) !== 1) throw new ServiceError("REMEDIATION_BUSY", "수정안을 준비하고 있습니다. 완료 후 다시 시도해 주세요.", 409);
    locked = true;
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT v.*, f.id AS finding_id, f.file_path, f.start_line, f.end_line, f.code_snippet, f.code_context, f.context_start_line, f.dependency_name, f.dependency_ecosystem, f.installed_version, m.ai_suggestion, m.dependency_assessment
      FROM vulnerabilities v JOIN repositories r ON r.id = v.repository_id
      JOIN scan_findings f ON f.vulnerability_id = v.id AND f.id = COALESCE(?, (SELECT f2.id FROM scan_findings f2 WHERE f2.vulnerability_id = v.id ORDER BY f2.created_at DESC, f2.id DESC LIMIT 1))
      LEFT JOIN finding_remediations m ON m.finding_id = f.id
      WHERE v.id = ? AND r.user_id = ?`, [job?.findingId ?? null, vulnerabilityId, userId]);
    const row = rows[0];
    if (!row) throw new ServiceError("VULNERABILITY_NOT_FOUND", "취약점 정보를 찾을 수 없습니다.", 404);
    const selection = job?.selection ?? await loadAiSelection(userId, connection);
    const generate = (instruction: string, evidence: unknown) => generateAiJson(selection, instruction, evidence, recordUsage);
    const recordUsage = async (usage: AiUsage) => {
      await connection.execute("INSERT INTO ai_usage_records (id, user_id, repository_id, vulnerability_id, feature, model_name, input_tokens, output_tokens, quantity, estimated_cost, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'USD')", [randomUUID(), userId, row.repository_id, vulnerabilityId, row.source === "sast" ? "semgrep_remediation" : "dependency_version_evidence", usage.model, usage.inputTokens, usage.outputTokens, selection.provider === "openrouter" ? 0 : null]);
    };
    if (row.source === "dependency") {
      const previous = parseStoredJson(row.dependency_assessment);
      if (!job && previous?.modelSelection && aiSelectionKey(previous.modelSelection) === aiSelectionKey(selection) && Date.now() - Date.parse(previous.checkedAt) < 60 * 60 * 1000) return { assessment: previous };
      const assessment = await assessUpgrade({ name: row.dependency_name ?? "", ecosystem: row.dependency_ecosystem ?? "", version: row.installed_version ?? "" }, row.external_id ?? "", aiProviderConfigured(selection.provider) ? async evidence => {
        const data = await generate('코드를 분석하지 마세요. 패키지 보안 공지와 NVD 근거에서 이 취약점을 수정한 버전 후보만 추출하세요. CVE 영향 범위 밖이라는 이유만으로 수정 버전을 확정하거나 버전 숫자를 임의로 증가시키지 마세요. 근거가 없으면 version=null. 형식: {"version": "x.y.z 또는 null", "reason": "근거 및 확인이 필요한 점"}. reason에 제공된 근거의 문구를 명시하세요.', evidence);
        return { version: data.version === null ? null : aiText(data.version, 100), reason: aiText(data.reason, 2000) };
      } : undefined);
      assessment.modelSelection = selection;
      await connection.execute("INSERT INTO finding_remediations (finding_id, dependency_assessment, checked_at) VALUES (?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE dependency_assessment = VALUES(dependency_assessment), checked_at = UTC_TIMESTAMP(3)", [row.finding_id, JSON.stringify(assessment)]);
      return { assessment };
    }
    const beforeCode = row.code_context || row.code_snippet;
    const evidenceKey = remediationEvidenceKey({ rule: row.external_id ?? "", description: row.description ?? "", impact: row.impact ?? "", filePath: row.file_path ?? "", code: beforeCode ?? "", startLine: row.context_start_line ?? row.start_line ?? 1 });
    const previousSuggestion = parseStoredJson(row.ai_suggestion);
    if (previousSuggestion?.evidenceKey === evidenceKey && previousSuggestion?.modelSelection && aiSelectionKey(previousSuggestion.modelSelection) === aiSelectionKey(selection)) return { suggestion: previousSuggestion };
    const [cached] = await connection.execute<RowDataPacket[]>(`SELECT m.ai_suggestion FROM scan_findings f JOIN finding_remediations m ON m.finding_id = f.id
      WHERE f.vulnerability_id = ? AND f.id <> ? AND f.code_snippet <=> ? AND f.code_context <=> ? AND m.ai_suggestion IS NOT NULL
      ORDER BY f.created_at DESC, f.id DESC`, [vulnerabilityId, row.finding_id, row.code_snippet, row.code_context]);
    const reusable = cached.map(item => parseStoredJson(item.ai_suggestion)).find(item => item?.evidenceKey === evidenceKey && item?.modelSelection && aiSelectionKey(item.modelSelection) === aiSelectionKey(selection));
    if (reusable) {
      await connection.execute("INSERT INTO finding_remediations (finding_id, ai_suggestion, checked_at) VALUES (?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE ai_suggestion = VALUES(ai_suggestion), checked_at = UTC_TIMESTAMP(3)", [row.finding_id, JSON.stringify(reusable)]);
      return { suggestion: reusable };
    }
    if (!row.code_snippet || !row.file_path) throw new ServiceError("MISSING_CODE_EVIDENCE", "Semgrep이 탐지한 코드와 위치 정보가 필요합니다.", 422);
    const data = await generate('당신은 Semgrep이 이미 탐지한 문제의 수정안 작성자입니다. 새 취약점 탐지, 위험도 변경, 저장소 전체 분석은 하지 마세요. 주어진 규칙·설명·영향·코드 조각을 바탕으로 그 문제의 수정안만 제안하세요. 제공되지 않은 파일·호출 경로를 알고 있다고 가정하지 마세요. code에는 탐지 구간과 주변 문맥이 포함되어 있습니다. findingStartLine/findingEndLine의 문제만 수정하고 주변 줄은 그대로 유지하세요. afterCode는 생략 기호나 마크다운 없이 제공된 code 전체의 수정본이어야 합니다. 코드 조각 범위의 수정 전/후 비교를 위한 JSON: {"summary":"해결 방법과 문맥 한계", "changes":["변경점"], "afterCode":"수정된 코드 조각", "verification":"적용 후 필요한 테스트. 테스트를 실행했다고 주장하지 마세요."}.', { rule: row.external_id, description: row.description, impact: row.impact, filePath: row.file_path, code: beforeCode, contextStartLine: row.context_start_line ?? row.start_line, findingStartLine: row.start_line, findingEndLine: row.end_line });
    if (!Array.isArray(data.changes) || !data.changes.length || data.changes.length > 10) throw new ServiceError("INVALID_AI_RESPONSE", "AI 수정안의 변경점 형식이 올바르지 않습니다.", 502);
    const suggestion: NonNullable<Vulnerability["aiSuggestion"]> = { evidenceKey, modelSelection: selection, summary: aiText(data.summary, 2000), changes: data.changes.map(value => aiText(value, 1000)), filePath: row.file_path, beforeCode, startLine: row.context_start_line ?? row.start_line ?? 1, afterCode: aiText(data.afterCode, 20000), verification: aiText(data.verification, 2000) };
    await connection.execute("INSERT INTO finding_remediations (finding_id, ai_suggestion, checked_at) VALUES (?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE ai_suggestion = VALUES(ai_suggestion), checked_at = UTC_TIMESTAMP(3)", [row.finding_id, JSON.stringify(suggestion)]);
    return { suggestion };
  } finally {
    if (locked) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]).catch(() => {});
    connection.release();
  }
}
