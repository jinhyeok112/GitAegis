import "server-only";
import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import type { AiModelOption, AiModelSelection } from "@/lib/types";
import { defaultAiSelection, geminiFreeModels } from "@/lib/ai-models";
import { getDatabase } from "@/lib/server/db";
import { object, securityJson } from "@/lib/server/security-http";
import { ServiceError } from "@/lib/server/errors";

export function defaultSelection(): AiModelSelection {
  const model = process.env.OPENROUTER_MODEL?.trim();
  return model && (model.endsWith(":free") || model === "openrouter/free") ? { provider: "openrouter", model } : { ...defaultAiSelection };
}

export function aiProviderConfigured(provider: AiModelSelection["provider"]) {
  return Boolean((provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY)?.trim());
}

export async function loadAiSelection(userId: string, connection?: PoolConnection): Promise<AiModelSelection> {
  const [rows] = await (connection ?? getDatabase()).execute<RowDataPacket[]>("SELECT provider, model_id FROM user_ai_settings WHERE user_id = ?", [userId]);
  return rows.length ? { provider: rows[0].provider, model: rows[0].model_id } : defaultSelection();
}

function parseOpenRouterModels(value: unknown): Omit<AiModelOption, "available">[] {
  const data = object(value).data;
  if (!Array.isArray(data)) throw new Error("Invalid model catalog");
  const result: Omit<AiModelOption, "available">[] = [{ provider: "openrouter", model: "openrouter/free", label: "무료 모델 자동 선택" }];
  for (const raw of data) {
    const row = object(raw), pricing = object(row.pricing), architecture = object(row.architecture);
    if (typeof row.id !== "string" || row.id.length > 191 || !/^[a-zA-Z0-9_./:-]+:free$/.test(row.id)) continue;
    if (pricing.prompt !== "0" || pricing.completion !== "0" || !Array.isArray(architecture.input_modalities) || !architecture.input_modalities.includes("text") || !Array.isArray(architecture.output_modalities) || !architecture.output_modalities.includes("text")) continue;
    // Exclude endpoints with other positive mandatory price components too.
    if (Object.entries(pricing).some(([key, price]) => !["prompt", "completion", "overrides"].includes(key) && typeof price === "string" && Number(price) > 0)) continue;
    result.push({ provider: "openrouter", model: row.id, label: typeof row.name === "string" ? row.name.slice(0, 200) : row.id });
  }
  return result;
}

export async function listAiModels(): Promise<{ models: AiModelOption[]; warning: string | null }> {
  const db = getDatabase();
  let router: Omit<AiModelOption, "available">[];
  let warning: string | null = null;
  const [cache] = await db.execute<RowDataPacket[]>("SELECT payload FROM security_api_cache WHERE cache_key = 'ai:openrouter-models' AND checked_at > UTC_TIMESTAMP(3) - INTERVAL 15 MINUTE");
  try {
    const catalog = cache.length ? (typeof cache[0].payload === "string" ? JSON.parse(cache[0].payload) : cache[0].payload) : await securityJson("https://openrouter.ai/api/v1/models");
    router = parseOpenRouterModels(catalog);
    if (!cache.length) await db.execute("INSERT INTO security_api_cache (cache_key, payload, checked_at) VALUES ('ai:openrouter-models', ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE payload = VALUES(payload), checked_at = UTC_TIMESTAMP(3)", [JSON.stringify(catalog)]);
  } catch {
    router = [{ provider: "openrouter", model: "openrouter/free", label: "무료 모델 자동 선택" }];
    warning = "OpenRouter의 개별 무료 모델 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.";
  }
  return { models: [...geminiFreeModels, ...router].map(item => ({ ...item, available: aiProviderConfigured(item.provider) })), warning };
}

export async function validateAiSelection(value: unknown): Promise<AiModelSelection> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceError("INVALID_AI_MODEL", "사용할 AI 모델을 선택해 주세요.", 400);
  const { provider, model } = value as Record<string, unknown>;
  if ((provider !== "gemini" && provider !== "openrouter") || typeof model !== "string" || model.length > 191) throw new ServiceError("INVALID_AI_MODEL", "지원하는 AI 모델을 선택해 주세요.", 400);
  const option = provider === "gemini" ? geminiFreeModels.find(item => item.model === model) : (await listAiModels()).models.find(item => item.provider === provider && item.model === model);
  if (!option) throw new ServiceError("INVALID_AI_MODEL", "선택한 모델이 현재 무료 지원 목록에 없습니다. AI 모델 설정을 확인해 주세요.", 400);
  if (!aiProviderConfigured(provider)) throw new ServiceError("AI_PROVIDER_NOT_CONFIGURED", `${provider === "gemini" ? "Gemini" : "OpenRouter"}의 서버 API 연결이 필요합니다.`, 503);
  return { provider, model };
}

export async function saveAiSelection(userId: string, value: unknown) {
  const selection = await validateAiSelection(value);
  await getDatabase().execute("INSERT INTO user_ai_settings (user_id, provider, model_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE provider = VALUES(provider), model_id = VALUES(model_id)", [userId, selection.provider, selection.model]);
  return selection;
}
