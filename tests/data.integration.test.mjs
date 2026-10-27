import assert from "node:assert/strict";
import { randomUUID, randomBytes, createCipheriv, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import mysql from "mysql2/promise";
import { encode } from "next-auth/jwt";
import { startApp } from "./helpers/app-server.mjs";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
const database = `gitaegis_test_${randomBytes(6).toString("hex")}`;
const secret = randomBytes(32).toString("base64url");
const encryptionKey = randomBytes(32);
const userId = randomUUID();
const otherUserId = randomUUID();
const otherRepositoryId = randomUUID();
const githubUserId = "900000000000001";
const token = "integration-test-token";
let db;
let app;
let cookie;
let repositoryId;
const policy = { scanOnPush: true, scheduledEnabled: true, frequency: "daily", weekday: 2, time: "13:45", timezone: "Asia/Seoul" };

function encryptedToken(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function runApp(overrides = {}) {
  return startApp({ secret, githubFixture: true, overrides: { MYSQL_DATABASE: database, GITHUB_TOKEN_ENCRYPTION_KEY: encryptionKey.toString("base64url"), ...overrides } });
}

function request(path, options = {}) {
  return fetch(`${app.origin}${path}`, { redirect: "manual", ...options, headers: { cookie, ...(options.method ? { origin: app.origin, "content-type": "application/json" } : {}), ...options.headers } });
}

before(async () => {
  assert.match(database, /^gitaegis_test_[a-f0-9]{12}$/);
  db = await mysql.createConnection({ host: process.env.MYSQL_HOST || "127.0.0.1", port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD || "", multipleStatements: true });
  await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  await db.query(`USE \`${database}\``);
  await db.query(await readFile(new URL("../database/schema.sql", import.meta.url), "utf8"));
  await db.execute("INSERT INTO users (id, github_user_id, github_login) VALUES (?, ?, ?), (?, ?, ?)", [userId, githubUserId, "integration-owner", otherUserId, "900000000000002", "other-owner"]);
  await db.execute("INSERT INTO github_accounts (user_id, encrypted_access_token, scope) VALUES (?, ?, ?)", [userId, encryptedToken(token), "read:user user:email repo"]);
  await db.execute("INSERT INTO repositories (id, user_id, github_repository_id, full_name, visibility, scan_on_push) VALUES (?, ?, ?, ?, ?, FALSE)", [otherRepositoryId, otherUserId, "777", "other-owner/private-repository", "private"]);
  const jwt = await encode({ token: { sub: userId, githubUserId, githubLogin: "integration-owner", name: "Integration User" }, secret, salt: "authjs.session-token", maxAge: 3600 });
  cookie = `authjs.session-token=${jwt}`;
  app = await runApp();
});

after(async () => {
  await app?.stop();
  if (db) {
    // This database is created by this test run; never touch application data.
    assert.match(database, /^gitaegis_test_[a-f0-9]{12}$/);
    await db.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await db.end();
  }
});

test("data endpoints require login and mutations reject cross-site origins", async () => {
  for (const path of ["/api/dashboard", "/api/github/repositories"]) {
    assert.equal((await fetch(`${app.origin}${path}`)).status, 401);
  }
  const response = await request("/api/repositories", { method: "POST", headers: { origin: "https://untrusted.example" }, body: JSON.stringify({ githubRepositoryId: "101", connected: true }) });
  assert.equal(response.status, 403);
});

test("empty MySQL account has no fake findings, subscription, or other users' repositories", async () => {
  const response = await request("/api/dashboard");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.repositories, []);
  assert.deepEqual(data.vulnerabilities, []);
  assert.deepEqual(data.scans, []);
  assert.equal(data.billing.aiRequests, 0);
  assert.equal(data.billing.subscriptionStatus, null);
  assert.equal(data.github.connected, true);
  assert.equal(data.github.privateAccess, true);
});

test("GitHub listing follows pagination and never returns the stored access token", async () => {
  const response = await request("/api/github/repositories");
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = JSON.parse(text);
  assert.equal(data.repositories.length, 101);
  assert.equal(data.repositories.at(-1).githubId, "101");
  assert.ok(!text.includes(token));
  const [rows] = await db.execute("SELECT encrypted_access_token FROM github_accounts WHERE user_id = ?", [userId]);
  assert.notEqual(rows[0].encrypted_access_token, token);
});

test("repository connection verifies GitHub access and saves trusted metadata in MySQL", async () => {
  const response = await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "101", connected: true, userId: otherUserId, name: "untrusted-name" }) });
  assert.equal(response.status, 200);
  const data = await (await request("/api/dashboard")).json();
  assert.equal(data.repositories.length, 1);
  repositoryId = data.repositories[0].id;
  assert.equal(data.repositories[0].name, "integration-owner/repository-101");
  const [rows] = await db.execute("SELECT user_id, connected FROM repositories WHERE id = ?", [repositoryId]);
  assert.equal(rows[0].user_id, userId);
  assert.equal(rows[0].connected, 1);
  const denied = await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "999", connected: true }) });
  assert.equal(denied.status, 403);
});

test("analysis policy persists and another user's repository cannot be modified", async () => {
  assert.equal((await request(`/api/repositories/${repositoryId}/policy`, { method: "PUT", body: JSON.stringify(policy) })).status, 200);
  const data = await (await request("/api/dashboard")).json();
  assert.deepEqual(data.scanPolicies[repositoryId], policy);
  assert.equal((await request(`/api/repositories/${otherRepositoryId}/policy`, { method: "PUT", body: JSON.stringify(policy) })).status, 404);
  const [rows] = await db.execute("SELECT scan_on_push FROM repositories WHERE id = ?", [otherRepositoryId]);
  assert.equal(rows[0].scan_on_push, 0);
  assert.equal((await request(`/api/repositories/${repositoryId}/policy`, { method: "PUT", body: JSON.stringify({ ...policy, time: "99:99" }) })).status, 400);
});

test("dashboard reads saved scan results, activity, and vulnerabilities from MySQL", async () => {
  const scanId = randomUUID();
  const vulnerabilityId = randomUUID();
  await db.execute("INSERT INTO scans (id, repository_id, trigger_type, status, sast_count, started_at) VALUES (?, ?, 'manual', 'completed', 1, UTC_TIMESTAMP(3))", [scanId, repositoryId]);
  await db.execute("INSERT INTO vulnerabilities (id, repository_id, fingerprint, source, title, severity, description) VALUES (?, ?, ?, 'sast', 'Integration test finding', 'medium', 'Saved in the isolated test database')", [vulnerabilityId, repositoryId, randomBytes(32).toString("hex")]);
  await db.execute("INSERT INTO scan_findings (id, scan_id, vulnerability_id, file_path, start_line, end_line) VALUES (?, ?, ?, 'src/test.ts', 2, 4)", [randomUUID(), scanId, vulnerabilityId]);
  const data = await (await request("/api/dashboard")).json();
  assert.equal(data.scans.length, 1);
  assert.equal(data.vulnerabilities.length, 1);
  assert.equal(data.vulnerabilities[0].filePath, "src/test.ts");
  assert.equal(data.activity.reduce((sum, day) => sum + day.scans, 0), 1);
});

test("disconnect preserves history and reconnect preserves analysis policy", async () => {
  assert.equal((await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "101", connected: false }) })).status, 200);
  let data = await (await request("/api/dashboard")).json();
  assert.equal(data.repositories[0].connected, false);
  assert.equal(data.scans.length, 1);
  assert.equal((await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "101", connected: true }) })).status, 200);
  data = await (await request("/api/dashboard")).json();
  assert.equal(data.repositories[0].id, repositoryId);
  assert.deepEqual(data.scanPolicies[repositoryId], policy);
});

test("saved connections survive an application server restart", async () => {
  await app.stop(); app = await runApp();
  const data = await (await request("/api/dashboard")).json();
  assert.equal(data.repositories[0].id, repositoryId);
  assert.deepEqual(data.scanPolicies[repositoryId], policy);
});

test("manual scan rejects other owners, disconnected repositories, and cross-site requests", async () => {
  assert.equal((await request(`/api/repositories/${otherRepositoryId}/scans`, { method: "POST" })).status, 404);
  assert.equal((await request(`/api/repositories/${repositoryId}/scans`, { method: "POST", headers: { origin: "https://untrusted.example" } })).status, 403);
  await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "101", connected: false }) });
  assert.equal((await request(`/api/repositories/${repositoryId}/scans`, { method: "POST" })).status, 409);
  await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "101", connected: true }) });
});

test("manual scan refuses a concurrent worker without creating a scan row", async () => {
  const lock = `gitaegis:scan:${createHash("sha256").update(database).digest("hex").slice(0, 24)}`;
  await db.execute("SELECT GET_LOCK(?, 0)", [lock]);
  const [before] = await db.execute("SELECT COUNT(*) AS count FROM scans");
  try {
    const response = await request(`/api/repositories/${repositoryId}/scans`, { method: "POST" });
    assert.equal(response.status, 409);
    const [after] = await db.execute("SELECT COUNT(*) AS count FROM scans");
    assert.equal(after[0].count, before[0].count);
  } finally { await db.execute("SELECT RELEASE_LOCK(?)", [lock]); }
});

test("manual scan runs real Semgrep and saves commit, findings, snippets, and SAST scope", async () => {
  const interrupted = randomUUID();
  await db.execute("INSERT INTO scans (id, repository_id, trigger_type, status, started_at) VALUES (?, ?, 'manual', 'running', UTC_TIMESTAMP(3))", [interrupted, repositoryId]);
  const response = await request(`/api/repositories/${repositoryId}/scans`, { method: "POST" });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.findings, 6);
  assert.equal(result.commitSha, "a".repeat(40));
  const data = await (await request("/api/dashboard")).json();
  const scan = data.scans.find(item => item.id === result.scanId);
  assert.equal(scan.status, "completed");
  assert.equal(scan.scope, "sast");
  assert.equal(scan.sastCount, 6);
  const [findings] = await db.execute("SELECT f.code_snippet, v.severity, v.title FROM scan_findings f JOIN vulnerabilities v ON v.id = f.vulnerability_id WHERE f.scan_id = ?", [result.scanId]);
  assert.equal(findings.length, 6);
  assert.equal(findings.filter(item => item.title.startsWith("검사용 샘플 · ") && item.severity === "info").length, 5);
  assert.ok(findings.every(item => item.code_snippet.length > 0));
  const redirect = data.vulnerabilities.find(item => item.description.includes("외부 리다이렉트 패턴"));
  assert.equal(redirect.isTestFixture, true);
  assert.match(redirect.impact, /피싱/);
  const tls = data.vulnerabilities.find(item => item.description.includes("TLS 인증서"));
  assert.equal(tls.isTestFixture, false);
  assert.match(tls.impact, /중간자 공격/);
  const [previous] = await db.execute("SELECT status FROM scans WHERE id = ?", [interrupted]);
  assert.equal(previous[0].status, "failed");
});

test("repeated manual scans reuse findings rather than duplicating vulnerabilities", async () => {
  await db.execute("UPDATE vulnerabilities SET impact = 'old generic impact' WHERE repository_id = ? AND external_id = 'gitaegis-fixture-open-redirect'", [repositoryId]);
  const [before] = await db.execute("SELECT COUNT(*) AS count FROM vulnerabilities WHERE repository_id = ?", [repositoryId]);
  const response = await request(`/api/repositories/${repositoryId}/scans`, { method: "POST" });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const [after] = await db.execute("SELECT COUNT(*) AS count FROM vulnerabilities WHERE repository_id = ?", [repositoryId]);
  assert.equal(after[0].count, before[0].count);
  const [updated] = await db.execute("SELECT impact FROM vulnerabilities WHERE repository_id = ? AND external_id = 'gitaegis-fixture-open-redirect'", [repositoryId]);
  assert.match(updated[0].impact, /피싱/);
});

test("invalid source archive is recorded as a failed scan without replacing previous results", async () => {
  await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "102", connected: true }) });
  const [rows] = await db.execute("SELECT id FROM repositories WHERE user_id = ? AND github_repository_id = 102", [userId]);
  const response = await request(`/api/repositories/${rows[0].id}/scans`, { method: "POST" });
  assert.equal(response.status, 422);
  const [scans] = await db.execute("SELECT status, error_message FROM scans WHERE repository_id = ?", [rows[0].id]);
  assert.equal(scans[0].status, "failed");
  assert.ok(scans[0].error_message);
});

test("database failure returns an error instead of fake empty results", async () => {
  const unavailable = await runApp({ MYSQL_PORT: "1" });
  try {
    const response = await fetch(`${unavailable.origin}/api/dashboard`, { headers: { cookie } });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.repositories, undefined);
    assert.ok(!JSON.stringify(data).includes(process.env.MYSQL_PASSWORD || "not-a-secret"));
  } finally { await unavailable.stop(); }
});
