import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { dependencyFindingTitle } from "../lib/finding-titles.mjs";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
const python = process.env.SCAN_PYTHON_EXECUTABLE || join(process.cwd(), ".tools", "semgrep", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const titlesOnly = process.argv.includes("--titles-only");
// Removed sample rules can still have historical findings in the database.
const historicalTitles = {
  "gitaegis-fixture-sql-injection": "입력값으로 DB 조회·변경 가능(CWE-89)",
  "gitaegis-fixture-path-traversal": "허용되지 않은 파일에 접근 가능(CWE-22)",
  "gitaegis-fixture-html-injection": "입력값으로 방문자 브라우저에서 코드 실행 가능(CWE-79)",
};
let connection;
try {
  // Read only the server-maintained rule files. Never load repository rules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())));
  const { stdout } = await promisify(execFile)(python, ["-B", "-c", "import json,sys; from ruamel.yaml import YAML; parser=YAML(typ='safe'); print(json.dumps([r for p in sys.argv[1:] for r in parser.load(open(p, encoding='utf-8'))['rules']], ensure_ascii=False))", "security_rules/manual.yaml", "security_fixtures/cases.yaml"], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, env: { ...env, PYTHONUTF8: "1" } });
  const rules = JSON.parse(stdout);
  if (!Array.isArray(rules) || rules.length > 100) throw new Error("Invalid rule catalog");
  for (const rule of rules) {
    if (!/^gitaegis-[a-z0-9-]+$/.test(rule.id) || typeof rule.message !== "string" || !rule.message.trim()) throw new Error("Missing rule copy");
  }
  connection = await mysql.createConnection({ host: process.env.MYSQL_HOST || "127.0.0.1", port: Number(process.env.MYSQL_PORT || 3306), database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD || "", connectTimeout: 5000 });
  await connection.beginTransaction();
  let updated = 0;
  for (const rule of rules) {
    const title = (rule.metadata.gitaegis_title || rule.message).slice(0, 500);
    if (titlesOnly) {
      const [result] = await connection.execute("UPDATE vulnerabilities SET title = ? WHERE source = 'sast' AND external_id = ?", [title, rule.id]);
      updated += result.affectedRows;
      continue;
    }
    const custom = typeof rule.metadata.gitaegis_description === "string" && rule.metadata.gitaegis_description.trim();
    const rawScore = rule.metadata.gitaegis_score;
    const score = rawScore != null && /^\d+(\.\d+)?$/.test(String(rawScore)) && Number(rawScore) <= 10 ? Number(rawScore) : null;
    const severity = score !== null ? score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "info" : rule.metadata.gitaegis_fixture ? "info" : rule.severity === "ERROR" ? "high" : "medium";
    const [result] = await connection.execute("UPDATE vulnerabilities SET title = ?, description = ?, description_source = ?, impact = ?, severity = ?, severity_score = ? WHERE source = 'sast' AND external_id = ?", [title, (custom ? rule.metadata.gitaegis_description : rule.message).slice(0, 4000), custom ? "rule" : "semgrep", rule.metadata.gitaegis_impact?.slice(0, 4000) ?? null, severity, score, rule.id]);
    updated += result.affectedRows;
  }
  if (titlesOnly) for (const [ruleId, title] of Object.entries(historicalTitles)) {
    const [result] = await connection.execute("UPDATE vulnerabilities SET title = ? WHERE source = 'sast' AND external_id = ?", [title, ruleId]);
    updated += result.affectedRows;
  }
  if (titlesOnly) {
    const [rows] = await connection.execute(`SELECT v.id, v.title, f.dependency_name, f.installed_version FROM vulnerabilities v
      JOIN scan_findings f ON f.id = (SELECT f2.id FROM scan_findings f2 WHERE f2.vulnerability_id = v.id ORDER BY f2.created_at DESC, f2.id DESC LIMIT 1)
      WHERE v.source = 'dependency' AND f.dependency_name IS NOT NULL AND f.installed_version IS NOT NULL`);
    for (const row of rows) {
      const prefix = `${row.dependency_name}@${row.installed_version}: `;
      // Current-format titles are already short; only transform saved originals.
      if (!row.title.startsWith(prefix)) continue;
      const title = dependencyFindingTitle(row.dependency_name, row.installed_version, row.title.slice(prefix.length));
      const [result] = await connection.execute("UPDATE vulnerabilities SET title = ? WHERE id = ? AND source = 'dependency'", [title, row.id]);
      updated += result.affectedRows;
    }
  }
  await connection.commit();
  console.log(titlesOnly ? `Finding titles synchronized: ${updated} matching findings. Descriptions, severity and scan history preserved.` : `Rule descriptions synchronized: ${updated} matching findings. Scan history and finding status preserved.`);
} catch (error) {
  await connection?.rollback().catch(() => {});
  console.error("Rule description synchronization failed:", error.code || "INVALID_RULE_COPY_OR_CONFIGURATION");
  process.exitCode = 1;
} finally { await connection?.end(); }
