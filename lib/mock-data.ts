import type { Repository, Scan, ScanPolicy, Vulnerability } from "@/lib/types";

export const mockUser = {
  name: "데모 사용자",
  githubLogin: "demo-developer",
  initial: "D",
};

export const repositories: Repository[] = [
  { id: "repo-1", name: "sample-shopping-api", visibility: "private", connected: true, lastScanAt: "오늘 09:20" },
  { id: "repo-2", name: "demo-community-web", visibility: "private", connected: true, lastScanAt: "오늘 09:12" },
  { id: "repo-3", name: "example-admin-server", visibility: "private", connected: false, lastScanAt: "지난주 14:30" },
  { id: "repo-4", name: "starter-landing-page", visibility: "public", connected: false, lastScanAt: null },
];

export const defaultScanPolicy: ScanPolicy = {
  scanOnPush: true,
  scheduledEnabled: false,
  frequency: "weekly",
  weekday: 1,
  time: "09:00",
  timezone: "Asia/Seoul",
};

export const initialScanPolicies: Record<string, ScanPolicy> = {
  "repo-1": { ...defaultScanPolicy, scheduledEnabled: true, frequency: "daily" },
  "repo-2": { ...defaultScanPolicy, scheduledEnabled: true, weekday: 3, time: "10:00" },
};

export const vulnerabilities: Vulnerability[] = [
  {
    id: "vuln-1", repositoryId: "repo-1", severity: "high", title: "SQL Injection",
    description: "사용자 입력값이 검증되지 않은 상태로 SQL 쿼리에 포함됩니다.",
    impact: "쿼리 구조를 변경해 비정상적인 데이터 조회나 변조를 일으킬 수 있습니다.",
    filePath: "src/api/user.ts", startLine: 41, endLine: 43,
    code: "const name = request.query.name;\nconst query = `SELECT * FROM users WHERE name = '${name}'`;\nreturn database.execute(query);",
    status: "new",
    aiSuggestion: {
      summary: "입력값을 SQL 문자열에 결합하는 대신 매개변수로 전달해 쿼리 구조가 바뀌지 않도록 합니다.",
      changes: ["SQL 문자열의 직접 결합을 제거합니다.", "플레이스홀더와 별도 매개변수 배열을 사용합니다."],
      filePath: "src/api/user.ts",
      beforeCode: "const name = request.query.name;\nconst query = `SELECT * FROM users WHERE name = '${name}'`;\nreturn database.execute(query);",
      afterCode: "const name = request.query.name;\nconst query = 'SELECT * FROM users WHERE name = ?';\nreturn database.execute(query, [name]);",
      verification: "사용 중인 DB 드라이버의 매개변수 문법을 확인하고, 수정 커밋을 재검사해야 합니다.",
    },
  },
  {
    id: "vuln-2", repositoryId: "repo-1", severity: "high", title: "lodash 명령 주입 · CVE-2021-23337",
    description: "lodash의 template 함수에서 발생하는 명령 주입 취약점입니다. 이 CVE는 4.17.21 미만 버전에 영향을 줍니다.",
    impact: "취약한 template 함수 사용 조건에서 공격자가 명령 실행을 유발할 수 있습니다.",
    filePath: "package-lock.json", startLine: null, endLine: null, code: null, status: "triaging",
    dependency: {
      packageName: "lodash", ecosystem: "npm", installedVersion: "4.17.20",
      affectedRange: "< 4.17.21", fixedVersion: "4.17.21",
      advisoryId: "CVE-2021-23337", advisoryUrl: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
    },
    aiSuggestion: {
      summary: "이 CVE가 수정된 최소 버전인 lodash 4.17.21 이상으로 업데이트합니다.",
      changes: ["package.json에서 lodash 버전을 변경합니다.", "패키지를 다시 설치해 package-lock.json을 갱신하고 의존성 검사를 다시 실행합니다."],
      filePath: "package.json · dependencies 일부",
      beforeCode: '"dependencies": {\n  "lodash": "4.17.20"\n}',
      afterCode: '"dependencies": {\n  "lodash": "4.17.21"\n}',
      verification: "예시는 해당 CVE의 최소 수정 버전입니다. 다른 보안 공지와 호환성을 확인하고 재검사하세요.",
    },
  },
  {
    id: "vuln-3", repositoryId: "repo-2", severity: "medium", title: "검증되지 않은 리다이렉트",
    description: "로그인 후 이동할 URL이 허용된 주소인지 충분히 확인되지 않습니다.",
    impact: "사용자가 공격자가 지정한 외부 사이트로 이동할 수 있습니다.",
    filePath: "src/auth/login.ts", startLine: 18, endLine: 20,
    code: "const next = request.query.next;\nreturn redirect(next);",
    status: "open",
    aiSuggestion: {
      summary: "이동할 URL을 현재 서비스 주소 기준으로 해석하고, 같은 출처의 URL만 허용합니다.",
      changes: ["외부 주소로 이동하지 않도록 URL의 origin을 비교합니다.", "주소가 잘못되었거나 외부 출처이면 기본 경로로 이동합니다."],
      filePath: "src/auth/login.ts",
      beforeCode: "const next = request.query.next;\nreturn redirect(next);",
      afterCode: "const origin = new URL(request.url).origin;\ntry {\n  const target = new URL(request.query.next ?? '/', origin);\n  if (target.origin !== origin) return redirect('/');\n  return redirect(target.href);\n} catch {\n  return redirect('/');\n}",
      verification: "외부 URL, 잘못된 URL, 정상 내부 경로를 테스트한 뒤 수정 커밋을 재검사하세요.",
    },
  },
];

export const scans: Scan[] = [
  { id: "scan-1", repositoryId: "repo-1", trigger: "schedule", status: "completed", sastCount: 6, cveCount: 1, commitSha: "9f31a2c", startedAt: "오늘 09:20" },
  { id: "scan-2", repositoryId: "repo-2", trigger: "push", status: "completed", sastCount: 3, cveCount: 0, commitSha: "a82d417", startedAt: "오늘 09:12" },
  { id: "scan-3", repositoryId: "repo-1", trigger: "push", status: "running", sastCount: 0, cveCount: 0, commitSha: "c14b821", startedAt: "방금 전" },
  { id: "scan-4", repositoryId: "repo-3", trigger: "schedule", status: "completed", sastCount: 0, cveCount: 0, commitSha: "b71e902", startedAt: "지난주 14:30" },
];

// Daily mock history is separate from the most recent scan records above.
export const activity = [
  { date: "9/23", repositories: [{ id: "repo-1", scans: 2, findings: 1 }, { id: "repo-2", scans: 1, findings: 0 }] },
  { date: "9/24", repositories: [{ id: "repo-1", scans: 3, findings: 2 }, { id: "repo-2", scans: 2, findings: 0 }] },
  { date: "9/25", repositories: [{ id: "repo-1", scans: 2, findings: 0 }, { id: "repo-2", scans: 2, findings: 0 }] },
  { date: "9/26", repositories: [{ id: "repo-1", scans: 5, findings: 3 }, { id: "repo-2", scans: 3, findings: 1 }] },
  { date: "9/27", repositories: [{ id: "repo-1", scans: 4, findings: 2 }, { id: "repo-2", scans: 2, findings: 1 }] },
  { date: "9/28", repositories: [{ id: "repo-1", scans: 7, findings: 3 }, { id: "repo-2", scans: 3, findings: 2 }] },
  { date: "9/29", repositories: [{ id: "repo-1", scans: 8, findings: 4 }, { id: "repo-2", scans: 4, findings: 2 }] },
];
