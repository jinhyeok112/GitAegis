import type { ResultSetHeader } from "mysql2";
import { requireDatabaseUser, requireSameOrigin, readJson } from "@/lib/server/request-auth";
import { getDatabase } from "@/lib/server/db";
import { errorResponse, ServiceError } from "@/lib/server/errors";
import { isScanPolicy, nextScheduledScan } from "@/lib/scan-policy";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
    const policy = await readJson(request);
    if (!isScanPolicy(policy)) throw new ServiceError("INVALID_POLICY", "분석 설정의 주기·요일·시각을 확인해 주세요.", 400);
    const { id } = await params;
    const time = `${policy.time}:00`;
    const next = policy.scheduledEnabled ? nextScheduledScan(new Date(), policy) : null;
    const [result] = await getDatabase().execute<ResultSetHeader>(`UPDATE repositories
      SET next_scheduled_at = IF(? = TRUE AND scheduled_scan_enabled = TRUE AND scheduled_scan_frequency = ?
        AND scheduled_scan_weekday = ? AND scheduled_scan_time = ? AND next_scheduled_at IS NOT NULL, next_scheduled_at, ?),
        scan_on_push = ?, scheduled_scan_enabled = ?, scheduled_scan_frequency = ?, scheduled_scan_weekday = ?,
        scheduled_scan_time = ?, scheduled_scan_timezone = ?
      WHERE id = ? AND user_id = ? AND connected = TRUE`, [policy.scheduledEnabled, policy.frequency, policy.weekday, time, next,
      policy.scanOnPush, policy.scheduledEnabled, policy.frequency, policy.weekday, time, policy.timezone, id, userId]);
    if (!result.affectedRows) throw new ServiceError("REPOSITORY_NOT_FOUND", "연결된 저장소를 찾을 수 없습니다.", 404);
    return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
