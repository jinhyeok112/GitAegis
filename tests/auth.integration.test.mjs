import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { encode } from "next-auth/jwt";

// Run against a production build with isolated test credentials. No GitHub
// account, real access token, or authentication-bypass route is used.
const require = createRequire(import.meta.url);
const secret = randomBytes(32).toString("base64url");
const cookieName = "authjs.session-token";
const sessionMaxAge = 7 * 24 * 60 * 60;
const identity = { sub: "test-github-user", name: "인증 테스트 사용자", githubLogin: "session-test-user" };
let app;

async function startApp(overrides = {}) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  // Next.js normalizes loopback callback URLs to localhost. Use that canonical
  // host consistently for OAuth redirects, just like the documented dev setup.
  const origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      AUTH_URL: origin,
      AUTH_SECRET: secret,
      AUTH_GITHUB_ID: "test-client-id",
      AUTH_GITHUB_SECRET: "test-client-secret",
      ...overrides,
    },
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Test server exited. ${output}`);
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return { origin, stop };
      } catch { /* Wait for the production server to bind its port. */ }
      await delay(250);
    }
    throw new Error(`Test server did not become ready. Run npm run build first. ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function sessionCookie(maxAge = sessionMaxAge) {
  const token = await encode({ token: identity, secret, salt: cookieName, maxAge });
  return `${cookieName}=${token}`;
}

function request(path, options = {}) {
  return fetch(`${app.origin}${path}`, { redirect: "manual", ...options });
}

function assertLoginRedirect(response) {
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location"), app.origin).pathname, "/login");
}

before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

test("first visit redirects to login without returning protected dashboard data", async () => {
  const response = await request("/");
  assertLoginRedirect(response);
  assert.doesNotMatch(await response.text(), /sample-shopping-api|CREATE TABLE/);
});

test("login page renders GitHub sign-in and explains persistent login", async () => {
  const response = await request("/login");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /GitHub 계정으로 시작하기/);
  assert.match(html, /GitHub로 계속하기/);
  assert.match(html, /7일간/);
  assert.doesNotMatch(html, /test-client-secret/);
  assert.match(response.headers.get("cache-control"), /private.*no-store/);
});

test("unknown OAuth error values display a safe fallback message", async () => {
  for (const error of ["unknown-error", "__proto__", "constructor"]) {
    const response = await request(`/login?error=${encodeURIComponent(error)}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /로그인을 완료하지 못했습니다. 다시 시도해 주세요/);
  }
});

test("valid encrypted cookie restores identity on repeated page requests", async () => {
  const cookie = await sessionCookie();
  for (let visit = 0; visit < 2; visit++) {
    const response = await request("/", { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /인증 테스트 사용자/);
    assert.match(html, /session-test-user/);
    assert.match(html, /보안 대시보드/);
    assert.match(response.headers.get("cache-control"), /private.*no-store/);
  }
  const response = await request("/login", { headers: { cookie } });
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location"), app.origin).pathname, "/");
});

test("forged and expired cookies cannot open the dashboard", async () => {
  for (const cookie of [`${cookieName}=forged-session`, await sessionCookie(-120)]) {
    assertLoginRedirect(await request("/", { headers: { cookie } }));
    const response = await request("/api/auth/session", { headers: { cookie } });
    assert.equal(await response.json(), null);
  }
});

test("session refresh issues an HttpOnly SameSite cookie with seven-day expiry", async () => {
  const response = await request("/api/auth/session", { headers: { cookie: await sessionCookie() } });
  const session = await response.json();
  assert.equal(session.user.githubLogin, identity.githubLogin);
  assert.equal(session.user.id, identity.sub);
  assert.equal(session.accessToken, undefined);
  assert.equal(session.user.accessToken, undefined);
  const remaining = (new Date(session.expires).getTime() - Date.now()) / 1000;
  assert.ok(remaining > sessionMaxAge - 20 && remaining <= sessionMaxAge);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`));
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);
  assert.match(cookie, /Expires=/i);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("GitHub authorization uses the configured callback, state, PKCE, and public/private repository scope", async () => {
  const csrf = await request("/api/auth/csrf");
  const { csrfToken } = await csrf.json();
  const cookie = csrf.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const response = await request("/api/auth/signin/github", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken, callbackUrl: app.origin }),
  });
  const url = new URL((await response.json()).url);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), `${app.origin}/api/auth/callback/github`);
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "read:user user:email repo");
  for (const name of ["authjs.state", "authjs.pkce.code_verifier"]) {
    assert.ok(response.headers.getSetCookie().some(value => value.startsWith(`${name}=`) && /HttpOnly/i.test(value)));
  }
  assert.doesNotMatch(url.toString(), /test-client-secret/);
});

test("sign-out rejects missing CSRF and clears the session with a valid CSRF token", async () => {
  const cookie = await sessionCookie();
  const rejected = await request("/api/auth/signout", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ callbackUrl: `${app.origin}/login` }),
  });
  assert.ok(!rejected.headers.getSetCookie().some(value => value.startsWith(`${cookieName}=;`)));

  const csrf = await request("/api/auth/csrf");
  const { csrfToken } = await csrf.json();
  const csrfCookies = csrf.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const response = await request("/api/auth/signout", {
    method: "POST",
    headers: { cookie: `${cookie}; ${csrfCookies}`, "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${app.origin}/login` }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, `${app.origin}/login`);
  const cleared = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=;`));
  assert.match(cleared, /Max-Age=0/i);
  assertLoginRedirect(await request("/"));
});

test("GitHub callback without an OAuth handshake cannot create a login session", async () => {
  const response = await request("/api/auth/callback/github?code=untrusted-code");
  const location = new URL(response.headers.get("location"), app.origin);
  assert.equal(location.pathname, "/login");
  assert.ok(location.searchParams.has("error"));
  assert.ok(!response.headers.getSetCookie().some(value => value.startsWith(`${cookieName}=`)));
});

test("missing GitHub credentials show a disabled sign-in button without granting access", async () => {
  const unconfigured = await startApp({ AUTH_GITHUB_SECRET: "" });
  try {
    const page = await fetch(`${unconfigured.origin}/login`);
    const html = await page.text();
    assert.match(html, /현재 GitHub 로그인을 사용할 수 없습니다/);
    assert.match(html, /<button[^>]*disabled/);
    assertLoginRedirect(await fetch(`${unconfigured.origin}/`, { redirect: "manual" }));
  } finally {
    await unconfigured.stop();
  }
});
