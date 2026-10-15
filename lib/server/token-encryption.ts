import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ServiceError } from "@/lib/server/errors";

function encryptionKey() {
  const key = Buffer.from(process.env.GITHUB_TOKEN_ENCRYPTION_KEY || "", "base64url");
  if (key.length !== 32) throw new ServiceError("TOKEN_KEY_MISSING", "저장소 인증을 위한 서버 설정이 필요합니다.");
  return key;
}

export function encryptGitHubToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptGitHubToken(value: string) {
  try {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted token");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 계정을 다시 연결해 주세요.", 409);
  }
}
