import type { ResultSetHeader } from "mysql2";
import { requireDatabaseUser, requireSameOrigin, readJson } from "@/lib/server/request-auth";
import { getDatabase } from "@/lib/server/db";
import { errorResponse, ServiceError } from "@/lib/server/errors";
import { isScanPolicy } from "@/lib/scan-policy";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
    const policy = await readJson(request);
    if (!isScanPolicy(policy)) throw new ServiceError("INVALID_POLICY", "분석 설정의 주기·요일·시각을 확인해 주세요.", 400);
    const { id } = await params;
    const [result] = await getDatabase().execute<ResultSetHeader>("UPDATE repositories SET scan_on_push = ?, scheduled_scan_enabled = ?, scheduled_scan_frequency = ?, scheduled_scan_weekday = ?, scheduled_scan_time = ?, scheduled_scan_timezone = ?, next_scheduled_at = NULL WHERE id = ? AND user_id = ? AND connected = TRUE", [policy.scanOnPush, policy.scheduledEnabled, policy.frequency, policy.weekday, `${policy.time}:00`, policy.timezone, id, userId]);
    if (!result.affectedRows) throw new ServiceError("REPOSITORY_NOT_FOUND", "연결된 저장소를 찾을 수 없습니다.", 404);
    return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
