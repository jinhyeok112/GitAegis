/** @param {string} packageName @param {string} version @param {string} summary */
export function dependencyFindingTitle(packageName, version, summary) {
  const text = summary.trim();
  const descriptions = [
    [/remote code execution/i, "외부 요청으로 서버 코드 실행 가능"],
    [/server.side request forgery|\bssrf\b/i, "외부 입력으로 내부 서버에 요청 가능"],
    [/cache poisoning.*cross.user|cache poisoning.*substitution/i, "캐시 변조로 다른 사용자 화면 변경 가능"],
    [/cache poisoning/i, "캐시 변조로 잘못된 페이지 제공 가능"],
    [/leak.*draft mode|draft mode.*leak/i, "임시 콘텐츠가 일반 사용자에게 노출될 수 있음"],
    [/cache leak|leak across/i, "캐시에서 다른 요청의 정보 노출 가능"],
    [/information disclosure.*development server/i, "개발 서버에서 내부 정보 노출 가능"],
    [/information disclosure|information leak|data leak/i, "내부 정보 노출 가능"],
    [/exhaust.*memory|memory.*exhaust|out.of.memory/i, "메모리 고갈로 서비스 중단 가능"],
    [/event.loop.*denial.of.service/i, "이벤트 처리 중단으로 서비스 마비 가능"],
    [/denial.of.service|\bdos\b|\bredos\b/i, "처리 과부하로 서비스 마비 가능"],
    [/cross.site scripting|\bxss\b/i, "방문자 브라우저에서 악성 코드 실행 가능"],
    [/sql injection/i, "입력값으로 DB 조회·변경 가능"],
    [/command injection/i, "입력값으로 서버 명령 실행 가능"],
    [/path traversal|directory traversal/i, "허용되지 않은 파일에 접근 가능"],
    [/authentication bypass|authorization bypass/i, "인증·권한 검사를 우회할 수 있음"],
    [/open redirect/i, "외부 사이트로 사용자 유도 가능"],
  ];
  const match = descriptions.find(([pattern]) => /** @type {RegExp} */ (pattern).test(text));
  // Unrecognized advisories keep their own wording instead of inventing a risk.
  const description = match ? String(match[1]) : text.length > 70 ? `${text.slice(0, 69)}…` : text || "패키지 보안 업데이트 필요";
  return `${packageName}@${version} · ${description}`.slice(0, 500);
}
