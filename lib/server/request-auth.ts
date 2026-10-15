import "server-only";
import type { RowDataPacket } from "mysql2";
import { auth } from "@/auth";
import { getDatabase } from "@/lib/server/db";
import { ServiceError } from "@/lib/server/errors";

export async function requireSession() {
  const session = await auth();
  if (!session?.user) throw new ServiceError("UNAUTHENTICATED", "로그인이 필요합니다.", 401);
  return session;
}

export async function requireDatabaseUser() {
  const session = await requireSession();
  if (!session.user.githubUserId) {
    // Check DB readiness before asking legacy sessions to reconnect.
    await getDatabase().query("SELECT 1");
    return { session, userId: null };
  }
  const [rows] = await getDatabase().execute<RowDataPacket[]>("SELECT id FROM users WHERE github_user_id = ?", [session.user.githubUserId]);
  return { session, userId: rows[0] ? String(rows[0].id) : null };
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.AUTH_URL || request.url).origin;
  if (origin !== expected) throw new ServiceError("INVALID_ORIGIN", "요청 출처를 확인할 수 없습니다.", 403);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ServiceError("INVALID_BODY", "JSON 요청이 필요합니다.", 400);
  if (Number(request.headers.get("content-length") || 0) > 4096) throw new ServiceError("INVALID_BODY", "요청이 너무 큽니다.", 400);
  try {
    const text = await request.text();
    if (text.length > 4096) throw new Error("Too large");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
    return value;
  } catch {
    throw new ServiceError("INVALID_BODY", "요청 내용을 확인해 주세요.", 400);
  }
}
