# 보안 검사와 수정안 생성 검증 샘플

실제 앱·인증·DB·API에 연결하지 않는 메모리 전용 샘플이다. Semgrep이 실제로 탐지한 결과만 저장한다. 점수는 생성 흐름을 검증하기 위한 **샘플 점수**이며, 실제 서비스의 CVSS 평가 결과가 아니다.

기존 경로 조작(CWE-22)과 HTML 삽입(CWE-79) 예제를 제거하고 아래 새 예제 3개를 추가했다. 후속 요청으로 기존 SQL 삽입 샘플도 제거하고 MD5·오래된 TLS 샘플을 추가했다. 현재 탐지 대상은 7개이며 각각 안전한 비교 코드가 있다. MD5·TLS 2개의 설명은 아래 Semgrep 원문을 그대로 사용하며 별도 한국어 설명을 추가하지 않는다.

| 패턴 | 샘플 점수 | 생성 시점 |
| --- | --- | --- |
| 명령 삽입(CWE-78) | 9.1 | 검사 후 사전 생성 |
| 외부 리다이렉트(CWE-601) | 6.1 | 처음 세부정보 열람 시 |
| 로그 삽입(CWE-117), 신규 | 5.3 | 처음 세부정보 열람 시 |
| 안전하지 않은 역직렬화(CWE-502), 신규 | 8.1 | 검사 후 사전 생성 |
| 서버 템플릿 삽입(CWE-1336), 신규 | 9.1 | 검사 후 사전 생성 |
| MD5 해시 사용(CWE-327), 추가 | 점수 미제공 · 정보 등급 | 처음 세부정보 열람 시 |
| 오래된 TLS 버전(CWE-326), 추가 | 점수 미제공 · 정보 등급 | 처음 세부정보 열람 시 |

`cases.py`의 취약 패턴은 바로 위 `ruleid` 주석, 안전한 비교 코드는 `ok` 주석으로 표시했다. `cases.yaml`은 서버가 유지하는 신뢰된 규칙이다. 제목은 `gitaegis_title`로 어떤 위험인지 짧게 표시하고 CWE를 함께 적는다. metadata의 `gitaegis_impact`와 `gitaegis_description`에는 피해 가능성과 해결 방법을 쉬운 문장으로 작성한다. `gitaegis_score`는 Semgrep 메타데이터 호환성을 위해 문자열로 저장한다.

## 실행 구조

`fixture_sink`의 모든 메서드는 Python 딕셔너리만 반환한다. 실제 SQL·셸 실행, 파일 작업, 네트워크·HTTP 이동, 로그 기록, 역직렬화, 템플릿 실행을 하지 않는다. 실제 비밀값이나 취약한 의존성도 포함하지 않는다. Next.js의 실행 코드에서 import하지 않는다.

## 확인

```bash
npm run test:fixtures
```

Python 표준 라이브러리로 외부 동작 API가 없는지 확인하고, 7쌍의 예제가 메모리 안에서만 동작하는지 검사한다.

Windows의 로컬 가상환경에서 규칙을 확인하려면:

```powershell
$env:PYTHONUTF8 = '1'
& .\.tools\semgrep\Scripts\semgrep.exe --test --metrics off --disable-version-check --config security_fixtures/cases.yaml security_fixtures/cases.py
```

기대 결과는 규칙 검사 7개 통과, 취약 패턴 7건, 안전한 비교 코드 0건이다. 통합 테스트는 모의 GitHub 압축 파일과 실제 Semgrep으로 탐지·문맥 저장·사전 생성·열람 시 생성·중복 방지·재시작 복구를 확인한다. AI와 외부 보안 API는 모의 응답을 사용한다.

수동 검사는 GitHub의 기본 브랜치를 읽으므로 변경된 샘플을 원격 저장소에 반영한 뒤 다시 검사해야 새 구성을 탐지한다. 기존 검사 이력은 그대로 보존된다. 이 작업은 원격 저장소에 자동으로 푸시하지 않는다.


MD5·TLS 규칙은 실제 암호화·통신 대신 메모리 sink 패턴에 적용한다. 메시지는 아래 Semgrep 규칙에서 그대로 보존했다. `gitaegis_description`과 `gitaegis_impact`는 넣지 않으며 DB에 `description_source=semgrep`으로 저장한다. 짧은 제목은 표시용 메타데이터로만 지정한다.

- [MD5 원문 규칙](https://github.com/semgrep/semgrep-rules/blob/develop/python/lang/security/insecure-hash-algorithms-md5.yaml)
- [TLS 원문 규칙](https://github.com/semgrep/semgrep-rules/blob/develop/python/lang/security/audit/weak-ssl-version.yaml)
