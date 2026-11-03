import "server-only";
import { createHash } from "node:crypto";

export function remediationEvidenceKey(evidence: { rule: string; description: string; impact: string; filePath: string; code: string; startLine: number }) {
  return createHash("sha256").update(JSON.stringify({ version: 2, ...evidence })).digest("hex");
}
