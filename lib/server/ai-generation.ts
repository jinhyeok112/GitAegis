import "server-only";
import type { AiModelSelection } from "@/lib/types";
import { openRouterJson, type AiUsage } from "@/lib/server/openrouter";
import { geminiJson } from "@/lib/server/gemini";

export async function generateAiJson(selection: AiModelSelection, instruction: string, evidence: unknown, recordUsage: (usage: AiUsage) => Promise<void>) {
  return selection.provider === "gemini" ? geminiJson(instruction, evidence, recordUsage, selection.model) : openRouterJson(instruction, evidence, recordUsage, selection.model);
}
