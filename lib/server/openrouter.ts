import "server-only";
import { object, securityJson } from "@/lib/server/security-http";
import { ServiceError } from "@/lib/server/errors";
import { evidenceInstruction, parseAiJson, usageTokens } from "@/lib/server/ai-json";
export { aiText } from "@/lib/server/ai-json";

export interface AiUsage { model: string; inputTokens: number; outputTokens: number }
type RecordUsage = (usage: AiUsage) => Promise<void>;

export async function openRouterJson(instruction: string, evidence: unknown, recordUsage: RecordUsage, selectedModel?: string) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new ServiceError("OPENROUTER_NOT_CONFIGURED", "OpenRouter API 키를 서버에 설정해 주세요.");
  const model = selectedModel ?? (process.env.OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b:free");
  if (!(model.endsWith(":free") || model === "openrouter/free")) throw new ServiceError("FREE_MODEL_REQUIRED", "무료 OpenRouter 모델 ID를 설정해 주세요.");
  let data: Record<string, unknown>;
  try {
    data = object(await securityJson("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-OpenRouter-Title": "GitAegis" },
      body: JSON.stringify({ model, stream: false, temperature: 0.1, max_tokens: 4096, provider: { max_price: { prompt: 0, completion: 0 } }, messages: [
        { role: "system", content: `${instruction}\n${evidenceInstruction}` },
        { role: "user", content: JSON.stringify(evidence).slice(0, 32000) },
      ] }),
    }, 60000));
  } catch { throw new ServiceError("OPENROUTER_UNAVAILABLE", "AI 응답을 받지 못했습니다. 무료 모델의 한도·가용성을 확인한 뒤 다시 시도해 주세요.", 502); }
  if (data.error) throw new ServiceError("OPENROUTER_UNAVAILABLE", "무료 AI 모델이 요청을 처리하지 못했습니다.", 502);
  const usage = data.usage ? object(data.usage) : {};
  await recordUsage({ model: typeof data.model === "string" ? data.model.slice(0, 100) : model, inputTokens: usageTokens(usage.prompt_tokens), outputTokens: usageTokens(usage.completion_tokens) });
  const choice = Array.isArray(data.choices) && data.choices[0] ? object(data.choices[0]) : {};
  return parseAiJson(choice.message ? object(choice.message).content : null, choice.finish_reason === "stop");
}
