import { randomUUID } from "node:crypto";
import { requireDatabaseUser, requireSameOrigin, readJson } from "@/lib/server/request-auth";
import { getDatabase } from "@/lib/server/db";
import { getAccessibleRepository } from "@/lib/server/github";
import { errorResponse, ServiceError } from "@/lib/server/errors";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { userId } = await requireDatabaseUser();
    if (!userId) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
    const body = await readJson(request);
    if (typeof body.githubRepositoryId !== "string" || !/^[1-9]\d{0,19}$/.test(body.githubRepositoryId) || typeof body.connected !== "boolean") throw new ServiceError("INVALID_BODY", "저장소와 연결 상태를 확인해 주세요.", 400);
    if (body.connected) {
      // Never trust owner/name/visibility supplied by a client. Fetch them using
      // the signed-in user's stored GitHub token before saving the connection.
      const repo = await getAccessibleRepository(userId, body.githubRepositoryId);
      await getDatabase().execute("INSERT INTO repositories (id, user_id, github_repository_id, full_name, visibility, default_branch, connected, scan_on_push) VALUES (?, ?, ?, ?, ?, ?, TRUE, FALSE) ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), visibility = VALUES(visibility), default_branch = VALUES(default_branch), connected = TRUE", [randomUUID(), userId, repo.githubId, repo.name, repo.visibility, repo.defaultBranch]);
    } else {
      await getDatabase().execute("UPDATE repositories SET connected = FALSE WHERE user_id = ? AND github_repository_id = ?", [userId, body.githubRepositoryId]);
    }
    return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
