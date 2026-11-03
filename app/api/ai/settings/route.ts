import { requireDatabaseUser, requireSameOrigin, readJson } from "@/lib/server/request-auth";
import { listAiModels, loadAiSelection, saveAiSelection } from "@/lib/server/ai-settings";
import { errorResponse, ServiceError } from "@/lib/server/errors";

export const runtime = "nodejs";

async function user() {
  const { userId } = await requireDatabaseUser();
  if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
  return userId;
}

export async function GET() {
  try {
    const userId = await user();
    const [selection, catalog] = await Promise.all([loadAiSelection(userId), listAiModels()]);
    return Response.json({ selection, ...catalog }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const userId = await user();
    const selection = await saveAiSelection(userId, await readJson(request));
    return Response.json({ selection }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
