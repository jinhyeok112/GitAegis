import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { geminiFreeModels } from "@/lib/ai-models";
import { object, securityJson, SecurityHttpError } from "@/lib/server/security-http";
import { evidenceInstruction, parseAiJson, usageTokens } from "@/lib/server/ai-json";
import type { AiUsage } from "@/lib/server/openrouter";
import { ServiceError } from "@/lib/server/errors";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function retryDelay(error: SecurityHttpError) {
  if (error.retryAfterMs !== null) return error.retryAfterMs;
  const details = record(record(error.body).error).details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    const value = record(detail).retryDelay;
    if (typeof value === "string" && /^\d+(\.\d+)?s$/.test(value)) return Number(value.slice(0, -1)) * 1000;
  }
  return null;
}

function geminiFailure(error: unknown): ServiceError {
  if (error instanceof SecurityHttpError) {
    const upstream = record(record(error.body).error);
    const details = Array.isArray(upstream.details) ? upstream.details.map(record) : [];
    const reasons = details.map(detail => detail.reason);
    const message = typeof upstream.message === "string" ? upstream.message : "";
    // Inspect provider details locally, but never show raw error text that may
    // echo credentials, project identifiers or submitted code.
    if (error.status === 401 || reasons.includes("API_KEY_INVALID") || /API key not valid|API key expired/i.test(message)) return new ServiceError("GEMINI_INVALID_KEY", "Gemini API 키가 유효하지 않거나 만료됐습니다. 서버의 API 키를 확인해 주세요.", 503);
    if (error.status === 403) return new ServiceError("GEMINI_ACCESS_DENIED", "Gemini API 접근이 거부됐습니다. API 키의 사용 제한과 Google 프로젝트 권한을 확인해 주세요.", 503);
    if (error.status === 404) return new ServiceError("GEMINI_MODEL_UNAVAILABLE", "선택한 Gemini 모델을 현재 API 프로젝트에서 사용할 수 없습니다. AI 모델 설정에서 다른 모델을 선택해 주세요.", 503);
    if (error.status === 429) {
      const violations = details.flatMap(detail => Array.isArray(detail.violations) ? detail.violations.map(record) : []);
      const daily = violations.some(item => /per.?day|daily/i.test(String(item.quotaId ?? item.quotaMetric ?? ""))) || /per.?day|daily/i.test(message);
      const zero = violations.some(item => item.quotaValue === 0 || item.quotaValue === "0") || /limit:\s*0(?:\D|$)/i.test(message);
      if (zero) return new ServiceError("GEMINI_QUOTA_UNAVAILABLE", "이 Gemini 모델에 사용할 수 있는 API 한도가 없습니다. Google AI Studio에서 프로젝트의 무료 한도·요금제를 확인하거나 다른 모델을 선택해 주세요.", 429);
      if (daily) return new ServiceError("GEMINI_DAILY_QUOTA_EXCEEDED", "이 Gemini 모델의 일일 요청·토큰 한도를 초과했습니다. 한도가 초기화된 후 다시 시도하거나 다른 모델을 선택해 주세요.", 429);
      const wait = retryDelay(error);
      return new ServiceError("GEMINI_RATE_LIMITED", `Gemini의 요청·토큰 한도를 일시적으로 초과했습니다. ${wait !== null ? `약 ${Math.max(1, Math.ceil(wait / 1000))}초 뒤에` : "잠시 후"} 다시 시도해 주세요.`, 429);
    }
    if (error.status === 400 && upstream.status === "FAILED_PRECONDITION") return new ServiceError("GEMINI_PROJECT_UNAVAILABLE", "현재 Google 프로젝트에서 Gemini 요청을 처리할 수 없습니다. 지원 지역과 API 프로젝트의 이용 조건을 확인해 주세요.", 503);
    if (error.status === 400) return new ServiceError("GEMINI_REQUEST_REJECTED", "Gemini가 요청 설정을 거절했습니다. 선택한 모델의 지원 형식과 API 설정을 확인해 주세요.", 502);
    if (error.status >= 500) return new ServiceError("GEMINI_TEMPORARILY_UNAVAILABLE", "Gemini 서버가 혼잡하거나 일시적으로 응답하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  }
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return new ServiceError("GEMINI_TIMEOUT", "Gemini 응답이 60초 안에 도착하지 않았습니다. 잠시 후 다시 시도하거나 다른 모델을 선택해 주세요.", 504);
  if (error instanceof SyntaxError) return new ServiceError("GEMINI_INVALID_RESPONSE", "Gemini 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.", 502);
  return new ServiceError("GEMINI_CONNECTION_FAILED", "Gemini 서버에 연결하지 못했습니다. 서버의 인터넷 연결을 확인하고 다시 시도해 주세요.", 502);
}

export async function geminiJson(instruction: string, evidence: unknown, recordUsage: (usage: AiUsage) => Promise<void>, model: string) {
  if (!geminiFreeModels.some(item => item.model === model)) throw new ServiceError("INVALID_AI_MODEL", "지원하는 Gemini 무료 티어 모델을 선택해 주세요.", 400);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ServiceError("GEMINI_NOT_CONFIGURED", "Gemini API 키를 서버에 설정해 주세요.");
  let data: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = object(await securityJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: `${instruction}\n${evidenceInstruction}` }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(evidence).slice(0, 32000) }] }], generationConfig: { maxOutputTokens: 4096, responseMimeType: "application/json" } }),
      }, 60000));
      break;
    } catch (error) {
      const wait = error instanceof SecurityHttpError ? retryDelay(error) : null;
      // Only retry an explicit transient server failure once. Do not repeat
      // authentication/quota failures or an ambiguous network timeout.
      if (attempt === 0 && error instanceof SecurityHttpError && [500, 502, 503, 504].includes(error.status) && (wait === null || wait <= 10000)) {
        await delay(Math.max(1000, wait ?? 2000));
        continue;
      }
      throw geminiFailure(error);
    }
  }
  const usage = data.usageMetadata ? object(data.usageMetadata) : {};
  await recordUsage({ model: `gemini/${model}`.slice(0, 100), inputTokens: usageTokens(usage.promptTokenCount), outputTokens: usageTokens(usage.candidatesTokenCount) + usageTokens(usage.thoughtsTokenCount) });
  const candidate = Array.isArray(data.candidates) && data.candidates[0] ? object(data.candidates[0]) : {};
  const blocked = record(data.promptFeedback).blockReason;
  if (blocked || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(String(candidate.finishReason))) throw new ServiceError("GEMINI_CONTENT_BLOCKED", "Gemini가 콘텐츠 제한으로 수정안을 생성하지 않았습니다. 요청한 코드 범위와 제공자 안내를 확인해 주세요.", 422);
  if (candidate.finishReason === "MAX_TOKENS") throw new ServiceError("GEMINI_OUTPUT_LIMIT", "Gemini가 응답 길이 한도에 도달해 수정안을 끝까지 작성하지 못했습니다. 다른 모델을 선택하거나 코드 범위를 줄여 다시 시도해 주세요.", 502);
  const content = candidate.content ? object(candidate.content) : {};
  const text = Array.isArray(content.parts) ? content.parts.map(object).filter(part => part.thought !== true && typeof part.text === "string").map(part => part.text).join("") : null;
  return parseAiJson(text, candidate.finishReason === "STOP");
}
