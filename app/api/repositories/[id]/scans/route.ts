import { requireDatabaseUser, requireSameOrigin } from "@/lib/server/request-auth";
import { runManualScan } from "@/lib/server/manual-scan";
import { errorResponse, ServiceError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
    const { id } = await params;
    return Response.json(await runManualScan(userId, id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
