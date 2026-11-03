import "server-only";

// Only callers choose the fixed service origin. Never follow advisory redirects.
export async function securityJson(url: string, init: RequestInit = {}, timeoutMs = 20000) {
  const response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Security service HTTP ${response.status}`); }
  return readSecurityJson(response);
}

export async function readSecurityJson(response: Response) {
  if (!response.body) throw new Error("Missing security response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw new Error("Security response exceeds limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid security response");
  return value as Record<string, unknown>;
}
