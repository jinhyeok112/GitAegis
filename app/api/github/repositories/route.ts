import { requireDatabaseUser } from "@/lib/server/request-auth";
import { listGitHubRepositories } from "@/lib/server/github";
import { errorResponse, ServiceError } from "@/lib/server/errors";

export async function GET() {
  try {
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "저장소 목록을 읽으려면 GitHub 계정을 다시 연결해 주세요.", 409);
    return Response.json(await listGitHubRepositories(userId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
