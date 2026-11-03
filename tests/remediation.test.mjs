import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadServerModule } from "./helpers/server-module.mjs";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.OPENROUTER_MODEL;
const originalGeminiKey = process.env.GEMINI_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = originalModel;
  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalGeminiKey;
});
const pkg = { name: "test-package", ecosystem: "npm", version: "1.0.0" };
const advisory = { id: "GHSA-test-original", summary: "old vulnerability", aliases: ["CVE-2026-12345"], affected: [{ package: { name: pkg.name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] };

function fixture({ versions = ["1.0.1", "1.0.2", "2.0.0"], ids = { "1.0.1": ["GHSA-test-other"] }, record = advisory, fail = false, paginate = false } = {}) {
  const queries = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.ok(!new Headers(init?.headers).has("authorization"));
    if (url.origin === "https://registry.npmjs.org") return Response.json({ name: pkg.name, versions: Object.fromEntries(versions.map(version => [version, {}])) });
    if (url.pathname.startsWith("/v1/vulns/")) return Response.json(record);
    if (url.pathname === "/v1/querybatch") {
      const batch = JSON.parse(init.body).queries;
      queries.push(...batch);
      return Response.json({ results: batch.map(query => {
        if (query.version === pkg.version) return { vulns: [{ id: record.id }] };
        if (fail) return { error: { message: "query failed" } };
        if (paginate && !query.page_token) return { next_page_token: "more" };
        return { vulns: (ids[query.version] ?? []).map(id => ({ id })) };
      }) });
    }
    throw new Error(`Unexpected service ${url.origin}`);
  };
  const api = loadServerModule("lib/server/upgrade-assessment.ts", { "@/lib/server/nvd": { getNvdEvidence: async () => null } });
  return { ...api, queries };
}

test("skips a CVE's fixed version when another vulnerability affects it, selects the exact earliest clean release", async () => {
  const api = fixture();
  const result = await api.assessUpgrade(pkg, advisory.id);
  assert.equal(result.status, "verified");
  assert.equal(result.recommendedVersion, "1.0.2");
  assert.deepEqual(result.publishedFixedVersions, ["1.0.1"]);
  assert.deepEqual(result.skippedVersions, [{ version: "1.0.1", advisoryIds: ["GHSA-test-other"] }]);
  assert.equal(result.nvdStatus, "unavailable");
});

test("missing fix data invokes AI, but an invented AI version cannot bypass registry and vulnerability checks", async () => {
  const api = fixture({ record: { ...advisory, affected: [] }, versions: ["1.0.1"] });
  let called = false;
  const result = await api.assessUpgrade(pkg, advisory.id, async evidence => { called = true; assert.equal(evidence.package.name, pkg.name); return { version: "9.9.9", reason: "unverified AI guess" }; });
  assert.equal(called, true);
  assert.equal(result.aiCandidateVersion, "9.9.9");
  assert.equal(result.status, "no_candidate");
  assert.equal(result.recommendedVersion, null);
});

test("candidate query error never becomes a clean result", async () => {
  const api = fixture({ fail: true });
  const result = await api.assessUpgrade(pkg, advisory.id);
  assert.equal(result.status, "unverified");
  assert.equal(result.recommendedVersion, null);
});

test("follows OSV pagination before accepting a release with initially empty results", async () => {
  const api = fixture({ paginate: true });
  const result = await api.assessUpgrade(pkg, advisory.id);
  assert.equal(result.recommendedVersion, "1.0.2");
  assert.ok(api.queries.some(query => query.version === "1.0.1" && query.page_token === "more"));
});

test("orders numeric versions correctly, excludes prereleases and flags major upgrades", async () => {
  const api = fixture({ versions: ["2.0.0-beta.1", "2.0.0", "10.0.0"], ids: {} });
  const result = await api.assessUpgrade(pkg, advisory.id);
  assert.equal(result.recommendedVersion, "2.0.0");
  assert.equal(result.majorUpdate, true);
  const unsupported = await api.assessUpgrade({ ...pkg, version: "1.0.0-beta.1" }, advisory.id);
  assert.equal(unsupported.status, "unverified");
});

test("lockfile parsing includes transitive and scoped packages and rejects unresolved sources", () => {
  const { lockPackages } = loadServerModule("lib/server/dependency-scan.ts");
  const packages = { "": {}, "node_modules/first": { version: "1.0.0" }, "node_modules/first/node_modules/@scope/second": { version: "2.0.0" } };
  assert.deepEqual(lockPackages({ lockfileVersion: 3, packages }).map(pkg => pkg.name), ["first", "@scope/second"]);
  assert.throws(() => lockPackages({ lockfileVersion: 1, packages }));
  assert.throws(() => lockPackages({ lockfileVersion: 3, packages: { "node_modules/first": { version: "1.0.0", resolved: "git+https://example.org/repo" } } }));
});

test("NVD public access persists request spacing, uses no key and reuses cached CVE evidence", async () => {
  const waits = [], events = [];
  let saved = null, calls = 0;
  const connection = {
    async execute(sql, params) {
      events.push(sql);
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.startsWith("SELECT payload")) return [saved ? [{ payload: saved }] : []];
      if (sql.includes("TIMESTAMPDIFF")) return [[{ elapsed: 1000 }]];
      if (sql.startsWith("INSERT") && params) saved = params[1];
      return [[]];
    }, release() {},
  };
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.match(url, /services\.nvd\.nist\.gov/);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(new Headers(init.headers).has("apiKey"), false);
    assert.ok(events.at(-1).includes("nvd:last-request"));
    return Response.json({ vulnerabilities: [{ cve: { id: "CVE-2026-12345", descriptions: [{ lang: "en", value: "fixed in 1.0.1" }], references: [], affected: [] } }] });
  };
  const { getNvdEvidence, NVD_PUBLIC_INTERVAL_MS } = loadServerModule("lib/server/nvd.ts", {
    "@/lib/server/db": { getDatabase: () => ({ getConnection: async () => connection }) },
    "node:timers/promises": { setTimeout: async ms => waits.push(ms) },
  });
  assert.equal(NVD_PUBLIC_INTERVAL_MS, 6100);
  assert.equal((await getNvdEvidence("CVE-2026-12345")).description, "fixed in 1.0.1");
  await getNvdEvidence("CVE-2026-12345");
  assert.deepEqual(waits, [5100]);
  assert.equal(calls, 1);
  assert.ok(events.some(sql => sql.includes("RELEASE_LOCK")));
});

test("NVD throttling honors Retry-After before another paced attempt", async () => {
  const waits = [];
  let calls = 0;
  const connection = { async execute(sql) {
    if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
    if (sql.includes("TIMESTAMPDIFF")) return [[{ elapsed: 0 }]];
    return [[]];
  }, release() {} };
  globalThis.fetch = async () => ++calls === 1 ? new Response("limited", { status: 429, headers: { "retry-after": "8" } }) : Response.json({ vulnerabilities: [] });
  const { getNvdEvidence } = loadServerModule("lib/server/nvd.ts", {
    "@/lib/server/db": { getDatabase: () => ({ getConnection: async () => connection }) },
    "node:timers/promises": { setTimeout: async ms => waits.push(ms) },
  });
  assert.equal(await getNvdEvidence("CVE-2026-12345"), null);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [6100, 8000, 6100]);
});

test("OpenRouter receives only supplied Semgrep evidence, stays free, records usage and rejects truncated output", async () => {
  process.env.OPENROUTER_API_KEY = "test-only-key";
  delete process.env.OPENROUTER_MODEL;
  let finish = "stop";
  const usage = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.match(body.model, /:free$/);
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0 });
    assert.deepEqual(JSON.parse(body.messages[1].content), { rule: "semgrep-rule", code: "snippet" });
    assert.equal(body.tools, undefined);
    return Response.json({ model: body.model, usage: { prompt_tokens: 15, completion_tokens: 20 }, choices: [{ finish_reason: finish, message: { content: '{"summary":"fix"}' } }] });
  };
  const { openRouterJson } = loadServerModule("lib/server/openrouter.ts");
  assert.deepEqual(await openRouterJson("Semgrep fix only", { rule: "semgrep-rule", code: "snippet" }, async item => usage.push(item)), { summary: "fix" });
  assert.equal(usage[0].inputTokens, 15);
  finish = "length";
  await assert.rejects(openRouterJson("Semgrep fix only", { rule: "semgrep-rule", code: "snippet" }, async item => usage.push(item)), error => error.code === "INVALID_AI_RESPONSE");
  process.env.OPENROUTER_MODEL = "paid/model";
  await assert.rejects(openRouterJson("fix", {}, async () => {}), error => error.code === "FREE_MODEL_REQUIRED");
});

test("Gemini uses the selected allowed model, keeps credentials in headers and rejects incomplete JSON output", async () => {
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  let finishReason = "STOP", calls = 0;
  const records = [];
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "test-only-gemini-key");
    assert.ok(!url.includes("test-only-gemini-key"));
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), { rule: "semgrep", code: "snippet" });
    return Response.json({ usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 20, thoughtsTokenCount: 5 }, candidates: [{ finishReason, content: { parts: [{ thought: true, text: "private reasoning" }, { text: '{"summary":"fix"}' }] } }] });
  };
  const { geminiJson } = loadServerModule("lib/server/gemini.ts");
  assert.deepEqual(await geminiJson("fix only", { rule: "semgrep", code: "snippet" }, async item => records.push(item), "gemini-3.5-flash-lite"), { summary: "fix" });
  assert.equal(records[0].model, "gemini/gemini-3.5-flash-lite");
  assert.equal(records[0].outputTokens, 25);
  finishReason = "MAX_TOKENS";
  await assert.rejects(geminiJson("fix only", { rule: "semgrep", code: "snippet" }, async () => {}, "gemini-3.5-flash-lite"), error => error.code === "INVALID_AI_RESPONSE");
  await assert.rejects(geminiJson("fix only", {}, async () => {}, "gemini-4-argon"), error => error.code === "INVALID_AI_MODEL");
  assert.equal(calls, 2);
});

test("OpenRouter model validation falls back to its free router if the catalog is unavailable", async () => {
  process.env.OPENROUTER_API_KEY = "test-only-key";
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  const { validateAiSelection, listAiModels } = loadServerModule("lib/server/ai-settings.ts", { "@/lib/server/db": { getDatabase: () => ({ execute: async () => [[]] }) } });
  const catalog = await listAiModels();
  assert.ok(catalog.warning);
  assert.ok(catalog.models.some(item => item.model === "openrouter/free"));
  await assert.rejects(validateAiSelection({ provider: "openrouter", model: "some/paid:free" }), error => error.code === "INVALID_AI_MODEL");
});
