import "server-only";
import { geminiFreeModels } from "@/lib/ai-models";
import { object, securityJson } from "@/lib/server/security-http";
import { evidenceInstruction, parseAiJson, usageTokens } from "@/lib/server/ai-json";
import type { AiUsage } from "@/lib/server/openrouter";
import { ServiceError } from "@/lib/server/errors";

export async function geminiJson(instruction: string, evidence: unknown, recordUsage: (usage: AiUsage) => Promise<void>, model: string) {
  if (!geminiFreeModels.some(item => item.model === model)) throw new ServiceError("INVALID_AI_MODEL", "지원하는 Gemini 무료 티어 모델을 선택해 주세요.", 400);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ServiceError("GEMINI_NOT_CONFIGURED", "Gemini API 키를 서버에 설정해 주세요.");
  let data: Record<string, unknown>;
  try {
    data = object(await securityJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: `${instruction}\n${evidenceInstruction}` }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(evidence).slice(0, 32000) }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: "application/json" } }),
    }, 60000));
  } catch { throw new ServiceError("GEMINI_UNAVAILABLE", "Gemini 응답을 받지 못했습니다. 선택한 모델의 API 한도·연결 상태를 확인해 주세요.", 502); }
  const usage = data.usageMetadata ? object(data.usageMetadata) : {};
  await recordUsage({ model: `gemini/${model}`.slice(0, 100), inputTokens: usageTokens(usage.promptTokenCount), outputTokens: usageTokens(usage.candidatesTokenCount) + usageTokens(usage.thoughtsTokenCount) });
  const candidate = Array.isArray(data.candidates) && data.candidates[0] ? object(data.candidates[0]) : {};
  const content = candidate.content ? object(candidate.content) : {};
  const text = Array.isArray(content.parts) ? content.parts.map(object).filter(part => part.thought !== true && typeof part.text === "string").map(part => part.text).join("") : null;
  return parseAiJson(text, candidate.finishReason === "STOP");
}
