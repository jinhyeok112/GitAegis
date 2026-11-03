// Loaded only by the isolated integration-test process, never by the application.
/* eslint-disable @typescript-eslint/no-require-imports -- Node preload must use CommonJS. */
const originalFetch = globalThis.fetch;
const { readFileSync } = require("node:fs");
const { gzipSync } = require("node:zlib");

function archiveFile(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000001\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function sourceArchive(withDependencies = false) {
  return gzipSync(Buffer.concat([
    archiveFile("repo/security_fixtures/cases.py", readFileSync("security_fixtures/cases.py")),
    archiveFile("repo/src/tls.js", Buffer.from("const unsafe = { rejectUnauthorized: false };\nconst safe = { rejectUnauthorized: true };\n")),
    ...(withDependencies ? [archiveFile("repo/package-lock.json", Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" }, "node_modules/gitaegis-test-package": { version: "1.0.0", resolved: "https://registry.npmjs.org/gitaegis-test-package/-/gitaegis-test-package-1.0.0.tgz" } } })))] : []),
    Buffer.alloc(1024),
  ]));
}
function repository(id) {
  return { id, full_name: `integration-owner/repository-${id}`, private: id % 2 === 0, html_url: `https://github.com/integration-owner/repository-${id}`, default_branch: "main", permissions: { pull: id !== 999 } };
}
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers ?? input.headers);
  if (["https://api.osv.dev", "https://registry.npmjs.org", "https://services.nvd.nist.gov"].includes(url.origin)) {
    if (headers.has("authorization")) throw new Error("Public vulnerability services must not receive API keys");
    if (url.origin === "https://registry.npmjs.org") return Response.json({ name: "gitaegis-test-package", versions: { "1.0.0": {}, "1.0.1": {}, "1.0.2": {}, "2.0.0": {} } });
    if (url.origin === "https://services.nvd.nist.gov") return Response.json({ vulnerabilities: [{ cve: { id: "CVE-2026-12345", descriptions: [{ lang: "en", value: "Fixture vulnerability fixed in 1.0.1" }], references: [{ url: "https://example.org/advisory" }], affected: [] } }] });
    if (url.pathname === "/v1/querybatch") return Response.json({ results: JSON.parse(init.body).queries.map(query => ({ vulns: (query.version === "1.0.0" ? ["GHSA-test-original"] : query.version === "1.0.1" ? ["GHSA-test-other"] : []).map(id => ({ id })) })) });
    if (url.pathname === "/v1/vulns/GHSA-test-original") return Response.json({ id: "GHSA-test-original", summary: "Test dependency vulnerability", details: "Test advisory only", aliases: ["CVE-2026-12345"], database_specific: { severity: "HIGH" }, affected: [{ package: { name: "gitaegis-test-package", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] });
    throw new Error("Unexpected public service fixture request");
  }
  if (url.origin === "https://openrouter.ai") {
    if (url.pathname === "/api/v1/models") return Response.json({ data: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA Nemotron Ultra (free)", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "cohere/north-mini-code:free", name: "North Mini Code (free)", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "test/not-free:free", name: "Paid variant", pricing: { prompt: "0.1", completion: "0.1" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "test/image:free", name: "Image only", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
    ] });
    if (headers.get("authorization") !== "Bearer test-only-openrouter-key") throw new Error("Integration tests must never use the real API key");
    const body = JSON.parse(init.body);
    if (!body.model.endsWith(":free")) throw new Error("Only free models allowed");
    const evidence = JSON.parse(body.messages[1].content);
    if (evidence.rule === "gitaegis-test-ai-failure") return Response.json({ error: { message: "fixture unavailable" } }, { status: 503 });
    return Response.json({ model: body.model, usage: { prompt_tokens: 80, completion_tokens: 120 }, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ summary: "TLS 인증서 검증을 활성화합니다.", changes: ["인증서 검증 옵션을 true로 변경"], afterCode: String(evidence.code).replace("false", "true"), verification: "인증서가 유효하지 않을 때 연결이 거절되는지 테스트하세요." }) } }] });
  }
  if (url.origin === "https://generativelanguage.googleapis.com") {
    if (headers.get("x-goog-api-key") !== "test-only-gemini-key") throw new Error("Integration tests must never use the real Gemini key");
    if (headers.has("authorization") || url.searchParams.has("key")) throw new Error("Use the provider-specific server header");
    const body = JSON.parse(init.body);
    const evidence = JSON.parse(body.contents[0].parts[0].text);
    const model = url.pathname.match(/models\/([^:]+):generateContent$/)?.[1];
    if (!model) throw new Error("Invalid Gemini model path");
    return Response.json({ modelVersion: model, usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 110, thoughtsTokenCount: 10 }, candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ summary: `Gemini 수정안 (${model})`, changes: ["TLS 검증 활성화"], afterCode: String(evidence.code).replace("false", "true"), verification: "인증서 검증을 테스트하세요." }) }] } }] });
  }
  if (url.origin === "https://codeload.github.com") {
    if (headers.has("authorization")) throw new Error("Archive requests must not forward the OAuth token");
    return new Response(sourceArchive(url.pathname.includes("repository-103/")), { headers: { "content-type": "application/gzip" } });
  }
  if (url.origin !== "https://api.github.com") return originalFetch(input, init);
  if (headers.get("authorization") !== "Bearer integration-test-token") return Response.json({ message: "Bad credentials" }, { status: 401 });
  if (url.pathname === "/user/repos") {
    const page = Number(url.searchParams.get("page"));
    return Response.json(page === 1 ? Array.from({ length: 100 }, (_, i) => repository(i + 1)) : page === 2 ? [repository(101)] : []);
  }
  if (/^\/repos\/integration-owner\/repository-\d+\/commits\/main$/.test(url.pathname)) return Response.json({ sha: "a".repeat(40) });
  if (/^\/repos\/integration-owner\/repository-\d+\/tarball\/[a-f0-9]{40}$/.test(url.pathname)) {
    if (url.pathname.includes("repository-102/")) return new Response("invalid archive");
    const repositoryNumber = url.pathname.match(/repository-(\d+)/)[1];
    return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/integration-owner/repository-${repositoryNumber}/tar.gz/` + "a".repeat(40) } });
  }
  const match = url.pathname.match(/^\/repositories\/(\d+)$/);
  if (match) return Response.json(repository(Number(match[1])));
  return Response.json({ message: "Not found" }, { status: 404 });
};
