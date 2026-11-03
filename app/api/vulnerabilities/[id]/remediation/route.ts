import { requireDatabaseUser, requireSameOrigin } from "@/lib/server/request-auth";
import { remediationState, requestRemediationJob } from "@/lib/server/remediation-jobs";
import { errorResponse, ServiceError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const result = await requestRemediationJob(userId, id, query.get("regenerate") === "1", query.get("retry") === "1");
    return Response.json(result, { status: ["queued", "running"].includes(result.state) ? 202 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
    return Response.json(await remediationState(userId, (await params).id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
