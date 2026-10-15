import assert from "node:assert/strict";
import { randomUUID, randomBytes, createCipheriv } from "node:crypto";
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
