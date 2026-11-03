import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServerModule } from "./helpers/server-module.mjs";

const { automaticallyReconnectGitHub, clearGitHubReconnectAttempt } = loadServerModule("lib/github-reconnect.ts");
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const authorization = "https://github.com/login/oauth/authorize?client_id=test&state=csrf-protected";

test("automatically begins OAuth once and falls back to manual retry until the new credential is verified", async () => {
  const sessionStorage = storage();
  let starts = 0;
  const navigations = [];
  const args = { userId: "user-a", storage: sessionStorage, begin: async () => { starts++; return { ok: true, url: authorization }; }, navigate: url => navigations.push(url) };
  assert.equal(await automaticallyReconnectGitHub(args), "redirecting");
  assert.deepEqual(navigations, [authorization]);
  assert.equal(await automaticallyReconnectGitHub(args), "failed");
  assert.equal(starts, 1);
  // A successful GitHub API response allows recovery for a later incident.
  clearGitHubReconnectAttempt(sessionStorage, "user-a");
  assert.equal(await automaticallyReconnectGitHub(args), "redirecting");
  assert.equal(starts, 2);
});

test("failed sign-in, blocked storage and unexpected redirect URLs lead to manual recovery", async () => {
  for (const result of [{ ok: false, url: null }, { ok: true, error: "AccessDenied", url: authorization }, { ok: true, url: "https://untrusted.example/login/oauth/authorize" }, { ok: true, url: "javascript:alert(1)" }]) {
    let navigated = false;
    assert.equal(await automaticallyReconnectGitHub({ userId: "user-a", storage: storage(), begin: async () => result, navigate: () => { navigated = true; } }), "failed");
    assert.equal(navigated, false);
  }
  let started = false;
  assert.equal(await automaticallyReconnectGitHub({ userId: "user-a", storage: { getItem() { throw new Error("disabled"); } }, begin: async () => { started = true; }, navigate() {} }), "failed");
  assert.equal(started, false);
});

test("a stalled OAuth start times out without a late navigation or a second automatic attempt", async () => {
  const sessionStorage = storage();
  let resolve, navigated = false;
  const args = { userId: "user-a", storage: sessionStorage, timeoutMs: 5, begin: () => new Promise(done => { resolve = done; }), navigate: () => { navigated = true; } };
  assert.equal(await automaticallyReconnectGitHub(args), "failed");
  resolve({ ok: true, url: authorization });
  await Promise.resolve();
  assert.equal(navigated, false);
  assert.equal(await automaticallyReconnectGitHub(args), "failed");
});
