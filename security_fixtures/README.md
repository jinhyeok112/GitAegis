# 안전한 보안 검사 샘플

GitAegis의 정적 분석과 오탐 검증에 사용할 소스 샘플이다. 실제 앱·인증·DB·API에는 연결하지 않는다. 가상 검사 결과를 DB에 입력하거나 대시보드에 표시하지 않는다.

## 포함한 패턴

| 종류 | CWE | 탐지 대상 | 안전한 비교 코드 |
| --- | --- | --- | --- |
| SQL 삽입 | CWE-89 | 입력을 SQL 문자열에 직접 결합 | 쿼리와 매개변수 분리 |
| 명령 삽입 | CWE-78 | 입력이 포함된 문자열을 shell=True에 전달 | 인수 배열과 shell=False |
| 경로 조작 | CWE-22 | 입력을 경로에 직접 결합 | 허용된 파일명만 선택 |
| HTML 삽입 / XSS | CWE-79 | 입력을 HTML 문자열에 직접 삽입 | HTML 텍스트 이스케이프 |
| 외부 리다이렉트 | CWE-601 | 임의 입력을 이동 주소로 사용 | 허용된 내부 경로만 선택 |

`cases.py`에 탐지 대상 5개와 안전한 비교 코드 5개를 넣었다. 취약 패턴은 바로 위 주석의 `ruleid`, 안전한 코드는 `ok`로 표시한다. `cases.yaml`의 전용 Semgrep 규칙이 이 표시와 실제 분석 결과를 비교한다.

## 실행해도 시스템에 영향을 주지 않는 구조

`fixture_sink`는 `InMemorySinks` 객체다. `execute`, `run`, `read`, `render`, `redirect`는 모두 **Python 딕셔너리만 반환하는 모형**이다.

- 실제 SQL 실행이나 DB 접속 없음.
- 실제 셸·외부 프로그램 실행 없음.
- 샘플에서 파일 읽기·쓰기 없음.
- 네트워크 요청이나 실제 HTTP 리다이렉트 없음.
- 브라우저에 HTML을 출력하는 경로 없음.
- 실제 비밀키·토큰·사용자 정보·취약한 의존성 설치 없음.
- Next.js의 `app`·`public` 밖에 있으며 앱에서 import하지 않음.

이 파일의 위험한 모양을 분석하는 것이 목적이다. 실제 시스템을 공격하거나 실제 취약점을 만들지 않는다. 전용 규칙은 `fixture_input()`과 모형 sink를 대상으로 하므로 범용 운영 보안 규칙을 대신하지 않는다.

## 안전성 검사

```bash
npm run test:fixtures
```

Python 표준 라이브러리만 사용한다. 검사기는 소스를 AST로 읽어 실제 시스템 API나 DB 클라이언트를 import하지 않는지 확인하고, 다섯 쌍을 호출해 결과가 메모리 안의 설명 데이터인지 확인한다. HTML·SQL·명령·경로 문자열은 실행하지 않는다.

## Semgrep 탐지 확인

Semgrep이 설치된 환경에서 프로젝트 루트 기준으로 실행한다.

```bash
semgrep --test --metrics off --disable-version-check --config security_fixtures/cases.yaml security_fixtures/cases.py
semgrep scan --metrics off --disable-version-check --config security_fixtures/cases.yaml security_fixtures/cases.py
```

기대 결과는 취약 패턴 **5건**, 안전한 비교 코드 **0건**이다. 테스트용 로컬 규칙을 사용하므로 다른 규칙 묶음의 탐지 건수가 같다고 가정하지 않는다. 실제 검사기는 이 규칙 파일을 함께 지정해야 모형 sink를 인식한다.

추가 시 검증 결과: Python 안전성 검사 6개 통과, Semgrep 규칙 검사 5개 통과, 실제 스캔의 의도된 탐지 5건 및 예기치 않은 탐지 0건. 앱 DB에 검사 결과를 입력하지 않았다.

Windows에서 이 작업의 검증용으로 준비한 로컬 가상환경을 사용할 때:

```powershell
& .\.tools\semgrep\Scripts\semgrep.exe --test --metrics off --disable-version-check --config security_fixtures/cases.yaml security_fixtures/cases.py
```

가상환경은 `.gitignore`로 제외하며 애플리케이션이 사용하지 않는다. GitHub에서 저장소를 복제해 검사하려면 먼저 샘플 파일과 규칙을 원격 저장소에 반영해야 한다. 이 샘플을 추가하는 것만으로 GitAegis의 아직 미연동인 검사 실행기가 동작하지는 않는다.

## 제거

사용을 마치면 `security_fixtures/` 폴더와 `package.json`의 `test:fixtures` 명령만 제거하면 된다. 앱의 인증·DB·저장소 연결에는 영향이 없다.
