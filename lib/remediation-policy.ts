import type { Severity } from "@/lib/types";

export const PREGENERATE_SCORE = 7;
export function shouldPregenerate(severity: Severity, score: number | null, status: string) {
  return ["new", "open", "triaging"].includes(status) && (score !== null ? score >= PREGENERATE_SCORE : severity === "critical" || severity === "high");
}
