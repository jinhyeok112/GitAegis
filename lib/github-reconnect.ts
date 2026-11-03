type RetryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SignInResult = { ok: boolean; error?: string; url: string | null };
const retryKey = (userId: string) => `gitaegis:github-reconnect:${userId}`;

// This marker only prevents redirect loops. It never grants access or stores
// credentials, and is cleared only after a successful GitHub API request.
export async function automaticallyReconnectGitHub({ userId, storage, begin, navigate, timeoutMs = 20000 }: {
  userId: string; storage: RetryStorage; begin: () => Promise<SignInResult>; navigate: (url: string) => void; timeoutMs?: number;
}): Promise<"redirecting" | "failed"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!userId || storage.getItem(retryKey(userId))) return "failed";
    storage.setItem(retryKey(userId), "attempted");
    const result = await Promise.race([begin(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OAuth start timed out")), timeoutMs); })]);
    if (!result.ok || result.error || !result.url) return "failed";
    const target = new URL(result.url);
    if (target.origin !== "https://github.com" || target.pathname !== "/login/oauth/authorize") return "failed";
    navigate(target.href);
    return "redirecting";
  } catch { return "failed"; }
  finally { if (timer) clearTimeout(timer); }
}

export function clearGitHubReconnectAttempt(storage: RetryStorage, userId: string) {
  try { storage.removeItem(retryKey(userId)); } catch { /* Storage can be disabled by the browser. */ }
}
