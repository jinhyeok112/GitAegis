import "server-only";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { getDatabase } from "@/lib/server/db";
import { encryptGitHubToken, decryptGitHubToken } from "@/lib/server/token-encryption";
import { ServiceError } from "@/lib/server/errors";

export async function saveGitHubAccount(profile: { id: string; login: string; email: string | null }, accessToken: string, scope: string) {
  const encryptedToken = encryptGitHubToken(accessToken);
  const connection = await getDatabase().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("INSERT INTO users (id, github_user_id, github_login, email) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE github_login = VALUES(github_login), email = VALUES(email)", [randomUUID(), profile.id, profile.login, profile.email]);
    const [users] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE github_user_id = ?", [profile.id]);
    const userId = String(users[0].id);
    await connection.execute("INSERT INTO github_accounts (user_id, encrypted_access_token, scope) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE encrypted_access_token = VALUES(encrypted_access_token), scope = VALUES(scope), updated_at = CURRENT_TIMESTAMP(3)", [userId, encryptedToken, scope]);
    await connection.commit();
    return userId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getGitHubAccount(userId: string) {
  const [rows] = await getDatabase().execute<RowDataPacket[]>("SELECT encrypted_access_token, scope FROM github_accounts WHERE user_id = ?", [userId]);
  if (!rows[0]) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "저장소를 불러오려면 GitHub 계정을 다시 연결해 주세요.", 409);
  return { accessToken: decryptGitHubToken(String(rows[0].encrypted_access_token)), scope: String(rows[0].scope) };
}
