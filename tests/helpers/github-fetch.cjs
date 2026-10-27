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
function sourceArchive() {
  return gzipSync(Buffer.concat([
    archiveFile("repo/security_fixtures/cases.py", readFileSync("security_fixtures/cases.py")),
    archiveFile("repo/src/tls.js", Buffer.from("const unsafe = { rejectUnauthorized: false };\nconst safe = { rejectUnauthorized: true };\n")),
    Buffer.alloc(1024),
  ]));
}
function repository(id) {
  return { id, full_name: `integration-owner/repository-${id}`, private: id % 2 === 0, html_url: `https://github.com/integration-owner/repository-${id}`, default_branch: "main", permissions: { pull: id !== 999 } };
}
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers ?? input.headers);
  if (url.origin === "https://codeload.github.com") {
    if (headers.has("authorization")) throw new Error("Archive requests must not forward the OAuth token");
    return new Response(sourceArchive(), { headers: { "content-type": "application/gzip" } });
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
    return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/integration-owner/repository-101/tar.gz/" + "a".repeat(40) } });
  }
  const match = url.pathname.match(/^\/repositories\/(\d+)$/);
  if (match) return Response.json(repository(Number(match[1])));
  return Response.json({ message: "Not found" }, { status: 404 });
};
