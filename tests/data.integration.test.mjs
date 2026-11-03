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
  return startApp({ secret, githubFixture: true, overrides: { MYSQL_DATABASE: database, GITHUB_TOKEN_ENCRYPTION_KEY: encryptionKey.toString("base64url"), OPENROUTER_API_KEY: "test-only-openrouter-key", OPENROUTER_MODEL: "nvidia/nemotron-3-ultra-550b-a55b:free", GEMINI_API_KEY: "test-only-gemini-key", ...overrides } });
}

function request(path, options = {}) {
  return fetch(`${app.origin}${path}`, { redirect: "manual", ...options, headers: { cookie, ...(options.method ? { origin: app.origin, "content-type": "application/json" } : {}), ...options.headers } });
}

async function waitFor(check, message, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.fail(message);
}

async function completedRemediation(path) {
  let response = await request(path, { method: "POST" });
  if (response.status !== 202) return response;
  await waitFor(async () => {
    response = await request(path.split("?")[0]);
    const result = await response.clone().json();
    if (result.state === "failed") assert.fail(result.error);
    return result.state === "completed";
  }, "Remediation did not complete");
  return response;
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
  assert.equal(result.findings, 8);
  assert.equal(result.commitSha, "a".repeat(40));
  const data = await (await request("/api/dashboard")).json();
  const scan = data.scans.find(item => item.id === result.scanId);
  assert.equal(scan.status, "completed");
  assert.equal(scan.scope, "sast");
  assert.equal(scan.sastCount, 8);
  const [findings] = await db.execute("SELECT f.code_snippet, v.severity, v.title FROM scan_findings f JOIN vulnerabilities v ON v.id = f.vulnerability_id WHERE f.scan_id = ?", [result.scanId]);
  assert.equal(findings.length, 8);
  const displayed = data.vulnerabilities.filter(item => item.repositoryId === repositoryId && item.code);
  assert.equal(displayed.filter(item => item.isTestFixture).length, 7);
  assert.ok(displayed.some(item => item.severityScore === 5.3));
  assert.ok(displayed.some(item => item.severityScore === 8.1));
  assert.ok(displayed.some(item => item.severityScore === 9.1));
  assert.ok(displayed.every(item => item.codeContext && item.contextStartLine <= item.startLine && item.contextEndLine >= item.endLine));
  assert.ok(findings.every(item => item.code_snippet.length > 0));
  const redirect = data.vulnerabilities.find(item => item.title === "정상 링크로 피싱 사이트 유도 가능(CWE-601)");
  assert.equal(redirect.isTestFixture, true);
  assert.match(redirect.impact, /피싱/);
  const tls = data.vulnerabilities.find(item => item.title === "서버 인증서 미확인으로 통신 위조 가능(CWE-295)");
  assert.equal(tls.isTestFixture, false);
  assert.match(tls.impact, /중간자 공격/);
  assert.match(redirect.description, /허용된 내부 경로/);
  assert.ok(!redirect.title.includes(redirect.description));
  const md5 = displayed.find(item => item.title === "취약한 MD5 사용으로 데이터 위조 위험(CWE-327)");
  assert.equal(md5.descriptionSource, "semgrep");
  assert.equal(md5.description, "Detected MD5 hash algorithm which is considered insecure. MD5 is not collision resistant and is therefore not suitable as a cryptographic signature. Use SHA256 or SHA3 instead.");
  const tlsVersion = displayed.find(item => item.title === "오래된 TLS 사용으로 통신 유출 위험(CWE-326)");
  assert.equal(tlsVersion.descriptionSource, "semgrep");
  assert.equal(tlsVersion.description, "An insecure SSL version was detected. TLS versions 1.0, 1.1, and all SSL versions are considered weak encryption and are deprecated. Use 'ssl.PROTOCOL_TLSv1_2' or higher.");
  const [previous] = await db.execute("SELECT status FROM scans WHERE id = ?", [interrupted]);
  assert.equal(previous[0].status, "failed");
});

test("scan queues every finding at 7.0 or above without a three-item cap and leaves lower scores ungenerated", async () => {
  const [jobs] = await db.execute("SELECT j.id, v.severity_score FROM remediation_jobs j JOIN scan_findings f ON f.id = j.finding_id JOIN vulnerabilities v ON v.id = f.vulnerability_id WHERE v.repository_id = ?", [repositoryId]);
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every(job => job.severity_score === null || Number(job.severity_score) >= 7));
  await waitFor(async () => {
    const [rows] = await db.execute("SELECT COUNT(*) AS count FROM remediation_jobs WHERE status IN ('queued', 'running')");
    return rows[0].count === 0;
  }, "Pre-generation worker did not finish");
  const [done] = await db.execute("SELECT status FROM remediation_jobs");
  assert.ok(done.every(job => job.status === "completed"));
  const data = await (await request("/api/dashboard")).json();
  assert.ok(data.vulnerabilities.filter(item => item.severityScore >= 7).every(item => item.aiSuggestion));
  assert.ok(data.vulnerabilities.filter(item => item.severityScore !== null && item.severityScore < 7).every(item => !item.aiSuggestion));
});

test("repeated manual scans reuse findings and saved suggestions without new provider calls", async () => {
  await db.execute("UPDATE vulnerabilities SET impact = 'old generic impact' WHERE repository_id = ? AND external_id = 'gitaegis-fixture-open-redirect'", [repositoryId]);
  const [before] = await db.execute("SELECT COUNT(*) AS count FROM vulnerabilities WHERE repository_id = ?", [repositoryId]);
  const [usageBefore] = await db.execute("SELECT COUNT(*) AS count FROM ai_usage_records WHERE repository_id = ?", [repositoryId]);
  const response = await request(`/api/repositories/${repositoryId}/scans`, { method: "POST" });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const [after] = await db.execute("SELECT COUNT(*) AS count FROM vulnerabilities WHERE repository_id = ?", [repositoryId]);
  assert.equal(after[0].count, before[0].count);
  const [updated] = await db.execute("SELECT impact FROM vulnerabilities WHERE repository_id = ? AND external_id = 'gitaegis-fixture-open-redirect'", [repositoryId]);
  assert.match(updated[0].impact, /피싱/);
  const [usageAfter] = await db.execute("SELECT COUNT(*) AS count FROM ai_usage_records WHERE repository_id = ?", [repositoryId]);
  assert.equal(usageAfter[0].count, usageBefore[0].count);
});

test("first detail request queues lower-risk work once, returns immediately, and resumes after restart without an open browser", async () => {
  const [findings] = await db.execute("SELECT id FROM vulnerabilities WHERE repository_id = ? AND external_id = 'gitaegis-fixture-log-injection'", [repositoryId]);
  const path = `/api/vulnerabilities/${findings[0].id}/remediation`;
  const [before] = await db.execute("SELECT COUNT(*) AS count FROM ai_usage_records WHERE vulnerability_id = ?", [findings[0].id]);
  assert.equal(before[0].count, 0);
  const response = await request(path, { method: "POST" });
  assert.equal(response.status, 202);
  await Promise.all([request(path, { method: "POST" }), request(path, { method: "POST" })]);
  const [jobs] = await db.execute("SELECT j.id FROM remediation_jobs j JOIN scan_findings f ON f.id = j.finding_id WHERE f.vulnerability_id = ?", [findings[0].id]);
  assert.equal(jobs.length, 1);
  await app.stop();
  // Simulate a process that stopped after claiming the job but before saving.
  await db.execute("UPDATE remediation_jobs SET status = 'running', attempts = 1 WHERE id = ? AND status <> 'completed'", [jobs[0].id]);
  app = await runApp();
  await waitFor(async () => {
    const [done] = await db.execute("SELECT status FROM remediation_jobs WHERE id = ?", [jobs[0].id]);
    return done[0].status === "completed";
  }, "Restarted worker did not resume persisted work");
  const result = await (await request(path)).json();
  assert.ok(result.suggestion);
  const [usage] = await db.execute("SELECT COUNT(*) AS count FROM ai_usage_records WHERE vulnerability_id = ?", [findings[0].id]);
  assert.equal(usage[0].count, 1);
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

test("Semgrep remediation checks ownership, uses OpenRouter once, persists the suggestion and usage without changing the finding", async () => {
  const [rows] = await db.execute("SELECT id, severity, status FROM vulnerabilities WHERE repository_id = ? AND external_id = 'gitaegis-tls-verification-disabled'", [repositoryId]);
  // Rule ids remain owned by the trusted rule set, so locate by snippet if renamed.
  const [fallback] = await db.execute("SELECT v.id, v.severity, v.status FROM vulnerabilities v JOIN scan_findings f ON f.vulnerability_id = v.id WHERE v.repository_id = ? AND f.file_path = 'src/tls.js' LIMIT 1", [repositoryId]);
  const finding = rows[0] ?? fallback[0];
  assert.ok(finding);
  const path = `/api/vulnerabilities/${finding.id}/remediation`;
  assert.equal((await fetch(`${app.origin}${path}`, { method: "POST", headers: { origin: app.origin } })).status, 401);
  assert.equal((await fetch(`${app.origin}${path}`)).status, 401);
  assert.equal((await request(path, { method: "POST", headers: { origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await request(`/api/vulnerabilities/${randomUUID()}/remediation`, { method: "POST" })).status, 404);
  const otherVulnerability = randomUUID();
  const otherScan = randomUUID();
  await db.execute("INSERT INTO vulnerabilities (id, repository_id, fingerprint, source, title, severity) VALUES (?, ?, ?, 'sast', 'Other owner finding', 'high')", [otherVulnerability, otherRepositoryId, randomBytes(32).toString("hex")]);
  await db.execute("INSERT INTO scans (id, repository_id, trigger_type, status) VALUES (?, ?, 'manual', 'completed')", [otherScan, otherRepositoryId]);
  await db.execute("INSERT INTO scan_findings (id, scan_id, vulnerability_id, file_path, code_snippet) VALUES (?, ?, ?, 'private.js', 'private-code')", [randomUUID(), otherScan, otherVulnerability]);
  assert.equal((await request(`/api/vulnerabilities/${otherVulnerability}/remediation`, { method: "POST" })).status, 404);
  assert.equal((await request(`/api/vulnerabilities/${otherVulnerability}/remediation`)).status, 404);
  const response = await completedRemediation(path);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.match(result.suggestion.beforeCode, /false/);
  assert.match(result.suggestion.afterCode, /true/);
  assert.equal(result.suggestion.filePath, "src/tls.js");
  assert.equal((await request(path, { method: "POST" })).status, 200);
  const [usage] = await db.execute("SELECT COUNT(*) AS count, SUM(input_tokens) AS tokens FROM ai_usage_records WHERE vulnerability_id = ?", [finding.id]);
  assert.equal(usage[0].count, 1);
  assert.equal(Number(usage[0].tokens), 80);
  const [unchanged] = await db.execute("SELECT severity, status FROM vulnerabilities WHERE id = ?", [finding.id]);
  assert.equal(unchanged[0].severity, finding.severity);
  assert.equal(unchanged[0].status, finding.status);
  const dashboard = await (await request("/api/dashboard")).json();
  assert.equal(dashboard.vulnerabilities.find(item => item.id === finding.id).aiSuggestion.afterCode, result.suggestion.afterCode);
  assert.ok(dashboard.billing.aiRequests >= 1);
});

test("npm scan persists advisory candidates and remediation skips another vulnerable release with keyless NVD evidence", async () => {
  await request("/api/repositories", { method: "POST", body: JSON.stringify({ githubRepositoryId: "103", connected: true }) });
  const [repositories] = await db.execute("SELECT id FROM repositories WHERE user_id = ? AND github_repository_id = 103", [userId]);
  const response = await request(`/api/repositories/${repositories[0].id}/scans`, { method: "POST" });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.scope, "sast_dependency");
  assert.equal(result.sastCount, 8);
  assert.equal(result.dependencyCount, 1);
  let dashboard = await (await request("/api/dashboard")).json();
  const finding = dashboard.vulnerabilities.find(item => item.repositoryId === repositories[0].id && item.dependency);
  assert.equal(finding.dependency.fixedVersion, "1.0.1");
  const remediation = await completedRemediation(`/api/vulnerabilities/${finding.id}/remediation`);
  const assessment = await remediation.json();
  assert.equal(remediation.status, 200, JSON.stringify(assessment));
  assert.equal(assessment.assessment.recommendedVersion, "1.0.2");
  assert.equal(assessment.assessment.nvdStatus, "available");
  assert.deepEqual(assessment.assessment.skippedVersions, [{ version: "1.0.1", advisoryIds: ["GHSA-test-other"] }]);
  dashboard = await (await request("/api/dashboard")).json();
  assert.equal(dashboard.vulnerabilities.find(item => item.id === finding.id).dependency.assessment.recommendedVersion, "1.0.2");
});

test("AI model selection is authenticated, filtered, stored per user and survives server restart", async () => {
  assert.equal((await fetch(`${app.origin}/api/ai/settings`)).status, 401);
  let response = await request("/api/ai/settings");
  const initial = await response.json();
  assert.equal(response.status, 200);
  assert.equal(initial.selection.provider, "openrouter");
  assert.ok(initial.models.some(item => item.provider === "gemini" && item.model === "gemini-3.8-flash" && item.available));
  assert.ok(initial.models.some(item => item.model === "cohere/north-mini-code:free"));
  assert.ok(!initial.models.some(item => item.model === "test/not-free:free" || item.model === "test/image:free"));
  assert.ok(!JSON.stringify(initial).includes("test-only-gemini-key"));
  const selection = { provider: "gemini", model: "gemini-3.8-flash" };
  assert.equal((await request("/api/ai/settings", { method: "PUT", headers: { origin: "https://untrusted.example" }, body: JSON.stringify(selection) })).status, 403);
  for (const invalid of [{ provider: "gemini", model: "gemini-4-argon" }, { provider: "openrouter", model: "test/not-free:free" }, { provider: "unknown", model: "anything" }]) {
    assert.equal((await request("/api/ai/settings", { method: "PUT", body: JSON.stringify(invalid) })).status, 400);
  }
  response = await request("/api/ai/settings", { method: "PUT", body: JSON.stringify({ ...selection, userId: otherUserId }) });
  assert.equal(response.status, 200, await response.text());
  const [stored] = await db.execute("SELECT user_id, provider, model_id FROM user_ai_settings");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].user_id, userId);
  assert.equal(stored[0].model_id, selection.model);
  const otherJwt = await encode({ token: { sub: otherUserId, githubUserId: "900000000000002", githubLogin: "other-owner" }, secret, salt: "authjs.session-token", maxAge: 3600 });
  const other = await (await request("/api/ai/settings", { headers: { cookie: `authjs.session-token=${otherJwt}` } })).json();
  assert.equal(other.selection.provider, "openrouter");
  await app.stop(); app = await runApp();
  const restored = await (await request("/api/ai/settings")).json();
  assert.deepEqual(restored.selection, selection);
  assert.deepEqual((await (await request("/api/dashboard")).json()).aiSelection, selection);
});

test("model changes preserve saved suggestions until explicit regeneration uses the chosen provider", async () => {
  const [rows] = await db.execute("SELECT v.id FROM vulnerabilities v JOIN scan_findings f ON f.vulnerability_id = v.id WHERE v.repository_id = ? AND f.file_path = 'src/tls.js' LIMIT 1", [repositoryId]);
  const id = rows[0].id;
  const path = `/api/vulnerabilities/${id}/remediation`;
  const preserved = await (await request(path, { method: "POST" })).json();
  assert.equal(preserved.suggestion.modelSelection.provider, "openrouter");
  let response = await completedRemediation(`${path}?regenerate=1`);
  let data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.deepEqual(data.suggestion.modelSelection, { provider: "gemini", model: "gemini-3.8-flash" });
  assert.match(data.suggestion.summary, /gemini-3.8-flash/);
  await completedRemediation(`${path}?regenerate=1`);
  let [usage] = await db.execute("SELECT model_name, output_tokens, estimated_cost FROM ai_usage_records WHERE vulnerability_id = ?", [id]);
  assert.equal(usage.length, 2);
  assert.equal(usage.find(row => row.model_name === "gemini/gemini-3.8-flash").estimated_cost, null);
  assert.equal(usage.find(row => row.model_name === "gemini/gemini-3.8-flash").output_tokens, 120);
  const next = { provider: "openrouter", model: "cohere/north-mini-code:free" };
  assert.equal((await request("/api/ai/settings", { method: "PUT", body: JSON.stringify(next) })).status, 200);
  response = await completedRemediation(`${path}?regenerate=1`); data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.deepEqual(data.suggestion.modelSelection, next);
  [usage] = await db.execute("SELECT model_name FROM ai_usage_records WHERE vulnerability_id = ?", [id]);
  assert.equal(usage.length, 3);
  assert.ok(usage.some(row => row.model_name === next.model));
  const dashboard = await (await request("/api/dashboard")).json();
  assert.deepEqual(dashboard.vulnerabilities.find(item => item.id === id).aiSuggestion.modelSelection, next);
});

test("rejected GitHub credentials require reconnection without destroying the app session or saved account data", async () => {
  const [before] = await db.execute("SELECT encrypted_access_token FROM github_accounts WHERE user_id = ?", [userId]);
  const [history] = await db.execute("SELECT COUNT(*) AS count FROM scans s JOIN repositories r ON r.id = s.repository_id WHERE r.user_id = ?", [userId]);
  try {
    await db.execute("UPDATE github_accounts SET encrypted_access_token = ? WHERE user_id = ?", [encryptedToken("revoked-test-token"), userId]);
    const response = await request("/api/github/repositories");
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.equal(result.code, "GITHUB_RECONNECT_REQUIRED");
    assert.match(result.error, /거절/);
    assert.ok(!JSON.stringify(result).includes("revoked-test-token"));
    assert.equal((await request("/api/dashboard")).status, 200);
    const [after] = await db.execute("SELECT COUNT(*) AS count FROM scans s JOIN repositories r ON r.id = s.repository_id WHERE r.user_id = ?", [userId]);
    assert.equal(after[0].count, history[0].count);
    const settings = await (await request("/api/ai/settings")).json();
    assert.equal(settings.selection.model, "cohere/north-mini-code:free");
  } finally {
    await db.execute("UPDATE github_accounts SET encrypted_access_token = ? WHERE user_id = ?", [before[0].encrypted_access_token, userId]);
  }
});

test("failed automatic generation is persisted without repeated provider calls; manual retry can recover", async () => {
  const id = randomUUID(), scan = randomUUID(), finding = randomUUID();
  await db.execute("INSERT INTO vulnerabilities (id, repository_id, fingerprint, source, external_id, title, severity, description, impact) VALUES (?, ?, ?, 'sast', 'gitaegis-test-ai-failure', 'Retry test', 'medium', 'test-only', 'test-only')", [id, repositoryId, randomBytes(32).toString("hex")]);
  await db.execute("INSERT INTO scans (id, repository_id, trigger_type, status) VALUES (?, ?, 'manual', 'completed')", [scan, repositoryId]);
  await db.execute("INSERT INTO scan_findings (id, scan_id, vulnerability_id, file_path, code_snippet) VALUES (?, ?, ?, 'test-only.js', 'rejectUnauthorized: false')", [finding, scan, id]);
  const path = `/api/vulnerabilities/${id}/remediation`;
  assert.equal((await request(path, { method: "POST" })).status, 202);
  await waitFor(async () => (await (await request(path)).json()).state === "failed", "Failed job status was not saved");
  for (let i = 0; i < 3; i++) {
    const result = await (await request(path, { method: "POST" })).json();
    assert.equal(result.state, "failed");
    assert.ok(result.error);
  }
  const [jobs] = await db.execute("SELECT attempts FROM remediation_jobs WHERE finding_id = ?", [finding]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].attempts, 1);
  await db.execute("UPDATE vulnerabilities SET external_id = 'gitaegis-test-ai-success' WHERE id = ?", [id]);
  await db.execute("DELETE FROM security_api_cache WHERE cache_key = 'remediation:next-dispatch'");
  const response = await completedRemediation(`${path}?retry=1`);
  const result = await response.json();
  assert.equal(result.state, "completed");
  assert.match(result.suggestion.afterCode, /true/);
});
