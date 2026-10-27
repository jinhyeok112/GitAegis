import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import mysql from "mysql2/promise";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
const python = process.env.SCAN_PYTHON_EXECUTABLE || join(process.cwd(), ".tools", "semgrep", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
let connection;
try {
  // Read only the server-maintained rule files. Never load repository rules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())));
  const { stdout } = await promisify(execFile)(python, ["-B", "-c", "import json,sys; from ruamel.yaml import YAML; parser=YAML(typ='safe'); print(json.dumps([r for p in sys.argv[1:] for r in parser.load(open(p, encoding='utf-8'))['rules']], ensure_ascii=False))", "security_rules/manual.yaml", "security_fixtures/cases.yaml"], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, env: { ...env, PYTHONUTF8: "1" } });
  const rules = JSON.parse(stdout);
  if (!Array.isArray(rules) || rules.length > 100) throw new Error("Invalid rule catalog");
  for (const rule of rules) {
    if (!/^gitaegis-[a-z0-9-]+$/.test(rule.id) || typeof rule.message !== "string" || !rule.message.trim() || typeof rule.metadata?.gitaegis_impact !== "string" || !rule.metadata.gitaegis_impact.trim()) throw new Error("Missing rule copy");
  }
  connection = await mysql.createConnection({ host: process.env.MYSQL_HOST || "127.0.0.1", port: Number(process.env.MYSQL_PORT || 3306), database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD || "", connectTimeout: 5000 });
  await connection.beginTransaction();
  let updated = 0;
  for (const rule of rules) {
    const title = `${rule.metadata.gitaegis_fixture === true ? "검사용 샘플 · " : ""}${rule.message}`.slice(0, 500);
    const [result] = await connection.execute("UPDATE vulnerabilities SET title = ?, description = ?, impact = ? WHERE source = 'sast' AND external_id = ?", [title, rule.message.slice(0, 4000), rule.metadata.gitaegis_impact.slice(0, 4000), rule.id]);
    updated += result.affectedRows;
  }
  await connection.commit();
  console.log(`Rule descriptions synchronized: ${updated} matching findings. Scan history and finding status preserved.`);
} catch (error) {
  await connection?.rollback().catch(() => {});
  console.error("Rule description synchronization failed:", error.code || "INVALID_RULE_COPY_OR_CONFIGURATION");
  process.exitCode = 1;
} finally { await connection?.end(); }
