import "server-only";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ServiceError } from "@/lib/server/errors";
import { sourceContext } from "@/lib/code-diff";
import { scanDependencies, type DependencyFinding } from "@/lib/server/dependency-scan";

export interface ScanFinding {
  rule: string; file: string; line: number; endLine: number;
  code: string; message: string; description: string; impact: string; severity: "critical" | "high" | "medium" | "low" | "info"; fixture: boolean;
  score: number | null;
  descriptionSource: "rule" | "semgrep";
  codeContext: string; contextStartLine: number; contextEndLine: number;
}

function runProcess(executable: string, args: string[], cwd: string, timeout: number, work: string) {
  return new Promise<void>((resolveRun, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"].includes(key.toUpperCase())));
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: "ignore", env: { ...env, NODE_ENV: "production", PYTHONUTF8: "1", SEMGREP_ENABLE_VERSION_CHECK: "0", SEMGREP_SETTINGS_FILE: join(work, "settings.yml"), SEMGREP_LOG_FILE: join(work, "engine.log") } });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false }).on("error", () => child.kill());
      else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }, timeout);
    child.once("error", () => { clearTimeout(timer); reject(new ServiceError("ENGINE_UNAVAILABLE", "검사 실행기를 시작하지 못했습니다. 서버의 Semgrep·Python 설정을 확인해 주세요.")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new ServiceError("SCAN_TIMEOUT", "검사 제한 시간을 초과했습니다. 이전 검사 결과는 유지됩니다.", 422));
      else if (code !== 0) reject(new ServiceError("SCAN_ENGINE_FAILED", "소스 압축 해제 또는 정적 분석을 완료하지 못했습니다. 지원 파일·용량·실행기 상태를 확인해 주세요.", 422));
      else resolveRun();
    });
  });
}

export async function analyzeArchive(archive: string, work: string): Promise<{ findings: ScanFinding[]; dependencies: { findings: DependencyFinding[]; checked: boolean } }> {
  const root = process.cwd();
  const localBin = join(root, ".tools", "semgrep", process.platform === "win32" ? "Scripts" : "bin");
  const semgrep = process.env.SEMGREP_EXECUTABLE || join(localBin, process.platform === "win32" ? "semgrep.exe" : "semgrep");
  const python = process.env.SCAN_PYTHON_EXECUTABLE || join(localBin, process.platform === "win32" ? "python.exe" : "python");
  try { await Promise.all([access(semgrep), access(python)]); }
  catch { throw new ServiceError("ENGINE_UNAVAILABLE", "검사 실행기가 준비되지 않았습니다. 서버의 Semgrep·Python 경로를 설정해 주세요."); }
  const target = join(work, "source");
  await mkdir(target);
  await runProcess(python, ["-B", join(root, "scripts", "extract_scan_source.py"), archive, target], root, 20000, work);
  const output = join(work, "results.json");
  await runProcess(semgrep, ["scan", "--metrics", "off", "--disable-version-check", "--config", join(root, "security_rules", "manual.yaml"), "--config", join(root, "security_fixtures", "cases.yaml"), "--no-rewrite-rule-ids", "--no-git-ignore", "--jobs", "1", "--timeout", "5", "--max-memory", "512", "--max-target-bytes", "1048576", "--json", "--output", output, "--quiet", "."], target, 90000, work);
  if ((await stat(output)).size > 16 * 1024 * 1024) throw new ServiceError("TOO_MANY_FINDINGS", "검사 결과 용량이 한도를 초과했습니다.", 422);
  const report = JSON.parse(await readFile(output, "utf8"));
  if (!Array.isArray(report.results) || report.errors?.length || report.results.length > 1000) throw new ServiceError("INCOMPLETE_SCAN", "일부 파일을 분석하지 못했거나 결과 한도를 초과했습니다. 완료된 검사로 저장하지 않았습니다.", 422);
  const dependencies = await scanDependencies(target);
  if (!report.paths?.scanned?.length && !dependencies.checked) throw new ServiceError("INCOMPLETE_SCAN", "지원되는 코드 또는 의존성 파일이 없습니다.", 422);
  const findings: ScanFinding[] = [];
  for (const item of report.results) {
    const absolute = resolve(target, String(item.path));
    const file = relative(target, absolute);
    if (!file || isAbsolute(file) || file === ".." || file.startsWith(`..${sep}`)) throw new ServiceError("INVALID_SCAN_RESULT", "검사 결과의 파일 경로가 올바르지 않습니다.", 502);
    const line = Number(item.start?.line);
    const endLine = Number(item.end?.line);
    if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(endLine) || endLine < line || typeof item.check_id !== "string") throw new ServiceError("INVALID_SCAN_RESULT", "검사 결과의 위치 정보가 올바르지 않습니다.", 502);
    const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
    const context = sourceContext(lines, line, endLine);
    const fixture = item.extra?.metadata?.gitaegis_fixture === true;
    const rawScore = item.extra?.metadata?.gitaegis_score;
    const configuredScore = typeof rawScore === "string" && /^\d+(\.\d+)?$/.test(rawScore) ? Number(rawScore) : rawScore;
    const score = typeof configuredScore === "number" && configuredScore >= 0 && configuredScore <= 10 ? configuredScore : null;
    const severity = score !== null ? score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "info" : fixture ? "info" : item.extra?.severity === "ERROR" ? "high" : "medium";
    const impact = item.extra?.metadata?.gitaegis_impact;
    const description = item.extra?.metadata?.gitaegis_description;
    findings.push({ ...context, descriptionSource: typeof description === "string" && description.trim() ? "rule" : "semgrep", rule: item.check_id.slice(-191), file: file.split(sep).join("/"), line, endLine, code: lines.slice(line - 1, Math.min(endLine, line + 19)).join("\n").slice(0, 8000), description: typeof description === "string" && description.trim() ? description.slice(0, 4000) : String(item.extra?.message || item.check_id).slice(0, 4000), message: String(item.extra?.metadata?.gitaegis_title || item.extra?.message || item.check_id).slice(0, 4000), impact: typeof impact === "string" && impact.trim() ? impact.slice(0, 4000) : "이 규칙에 대한 영향 설명이 아직 등록되지 않았습니다. 코드의 입력 경로와 실행 권한을 확인해 주세요.", severity, score, fixture });
  }
  return { findings, dependencies };
}
