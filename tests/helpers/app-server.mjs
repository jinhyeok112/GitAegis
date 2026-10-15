import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

export async function startApp({ secret, overrides = {}, githubFixture = false }) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const origin = `http://localhost:${port}`;
  const preload = githubFixture ? ["--require", fileURLToPath(new URL("./github-fetch.cjs", import.meta.url))] : [];
  const child = spawn(process.execPath, [...preload, require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", AUTH_URL: origin, AUTH_SECRET: secret, AUTH_GITHUB_ID: "test-client-id", AUTH_GITHUB_SECRET: "test-client-secret", ...overrides },
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill(); await exited;
  };
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Test server exited. ${output}`);
      try {
        if ((await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2000) })).ok) return { origin, stop };
      } catch { /* Server is starting. */ }
      await delay(250);
    }
    throw new Error(`Test server did not become ready. Run npm run build first. ${output}`);
  } catch (error) { await stop(); throw error; }
}
