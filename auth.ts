import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isDatabaseConfigured } from "@/lib/server/db";
import { saveGitHubAccount } from "@/lib/server/github-account";

// A persistent cookie survives browser restarts. Keep the encryption key stable
// across application restarts so existing sessions remain readable.
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

export function isGitHubConfigured() {
  return Boolean(
    process.env.AUTH_GITHUB_ID?.trim() &&
    process.env.AUTH_GITHUB_SECRET?.trim() &&
    process.env.AUTH_SECRET?.trim(),
  );
}

export const { handlers, auth, signIn } = NextAuth({
  providers: [GitHub({
    checks: ["pkce", "state"],
    authorization: { params: { scope: "read:user user:email repo" } },
  })],
  pages: { signIn: "/login", error: "/login" },
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE },
  callbacks: {
    async jwt({ token, profile, account }) {
      // Access tokens are encrypted in MySQL, never copied to the browser session.
      if (profile && typeof profile.login === "string") {
        const githubUserId = String(profile.id);
        token.githubLogin = profile.login;
        token.githubUserId = githubUserId;
        if (account?.access_token && isDatabaseConfigured()) {
          token.sub = await saveGitHubAccount({
            id: githubUserId,
            login: profile.login,
            email: typeof profile.email === "string" ? profile.email : null,
          }, account.access_token, account.scope ?? "");
        }
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? "";
      session.user.githubLogin = typeof token.githubLogin === "string" ? token.githubLogin : "";
      session.user.githubUserId = typeof token.githubUserId === "string" ? token.githubUserId : "";
      return session;
    },
  },
});
