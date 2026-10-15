// Loaded only by the isolated integration-test process, never by the application.
const originalFetch = globalThis.fetch;
function repository(id) {
  return { id, full_name: `integration-owner/repository-${id}`, private: id % 2 === 0, html_url: `https://github.com/integration-owner/repository-${id}`, default_branch: "main", permissions: { pull: id !== 999 } };
}
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== "https://api.github.com") return originalFetch(input, init);
  const headers = new Headers(init?.headers ?? input.headers);
  if (headers.get("authorization") !== "Bearer integration-test-token") return Response.json({ message: "Bad credentials" }, { status: 401 });
  if (url.pathname === "/user/repos") {
    const page = Number(url.searchParams.get("page"));
    return Response.json(page === 1 ? Array.from({ length: 100 }, (_, i) => repository(i + 1)) : page === 2 ? [repository(101)] : []);
  }
  const match = url.pathname.match(/^\/repositories\/(\d+)$/);
  if (match) return Response.json(repository(Number(match[1])));
  return Response.json({ message: "Not found" }, { status: 404 });
};
