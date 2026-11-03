import type { AiModelSelection } from "@/lib/types";

export const defaultAiSelection: AiModelSelection = { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" };
export const geminiFreeModels = [
  { provider: "gemini" as const, model: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { provider: "gemini" as const, model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { provider: "gemini" as const, model: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
];
export function aiSelectionKey(selection: AiModelSelection) { return `${selection.provider}:${selection.model}`; }
export function aiSelectionLabel(selection: AiModelSelection) { return `${selection.provider === "gemini" ? "Gemini" : "OpenRouter"} · ${selection.model}`; }
