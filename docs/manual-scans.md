# 수동 검사와 결과 저장

## 사용

저장소 메뉴에서 저장소를 연결한 뒤 `수동 검사`를 누른다. 완료 안내에 탐지 건수와 커밋 SHA가 표시된다. 취약점 메뉴에서 코드 위치·설명·등급을 확인하고, 계정 및 사용량의 검사 기록에서 성공·실패와 실패 사유를 확인한다.

검사 대상은 **GitHub에 올라간 기본 브랜치의 특정 커밋**이다. 로컬의 미커밋·미푸시 변경은 포함하지 않는다. 안전 샘플도 원격에 반영한 뒤 검사해야 한다. 샘플 탐지는 `검사용 샘플`이라는 제목과 `정보` 등급으로 표시한다.

현재는 JavaScript·TypeScript·Python의 제한된 SAST 규칙을 실행한다. 일반 규칙은 동적 eval, TLS 검증 해제, Python 셸 실행·SQL 결합을 검토 대상으로 표시하며 전용 샘플 규칙 5개도 포함한다. 외부 입력의 실제 도달 가능성·영향은 사람이 검토한다. 탐지 0건은 전체 취약점이 없다는 판정이 아니다. 의존성·CVE·AI 분석은 실행하지 않으며 이력의 의존성 칸은 `미실행`으로 표시한다.

## 요청과 코드 구조

```text
수동 검사 버튼
  → POST /api/repositories/[id]/scans
  → 로그인·요청 출처·소유권·연결 상태 검증
  → DB 실행 잠금과 running 이력 생성
  → GitHub 접근 권한 재확인 → 기본 브랜치 SHA → 소스 압축 다운로드
  → Python 소스 추출 → Semgrep 정적 분석
  → 트랜잭션으로 취약점·코드 위치·완료 이력 저장
  → 화면 데이터 갱신 및 임시 소스 삭제
```

`app/api/repositories/[id]/scans/route.ts`는 서버 전용 진입점이다. 요청에서 명령·경로·사용자 ID를 받지 않는다. 세션으로 소유자를 결정하고 다른 사용자 저장소와 교차 사이트 요청을 거절한다.

`lib/server/manual-scan.ts`는 MySQL의 `GET_LOCK`을 연결에 유지한다. DB당 수동 검사를 한 번에 하나만 허용하고 중복 요청은 409로 거절한다. 잠금을 얻은 새 작업은 서버 중단으로 남은 `running` 이력을 실패로 바꾼다. 새 검사는 별도의 UUID를 가진다. 화면은 실행 중 주기적으로 상태를 갱신하고, 재시작으로 멈춘 이력이 남아도 수동 검사 재시도로 복구할 수 있다.

`lib/server/github.ts`는 저장된 토큰으로 접근 권한을 다시 확인한다. 기본 브랜치의 SHA를 확정한 뒤 그 SHA의 압축 파일을 요청하므로 도중에 브랜치가 바뀌어도 검사 버전을 식별할 수 있다. GitHub의 다운로드 리다이렉트는 HTTPS `codeload.github.com`만 허용하고 OAuth 토큰을 넘기지 않는다. 토큰·압축 주소를 브라우저에 전달하지 않는다.

`scripts/extract_scan_source.py`는 저장소의 JS·TS·Python 일반 파일만 새 임시 폴더에 복사한다. 경로 이탈·절대 경로·링크·장치·중복 경로를 거절하고 의존성·빌드 폴더는 제외한다. 저장소의 설치 스크립트나 프로그램은 실행하지 않는다.

`lib/server/scan-engine.ts`는 `spawn`의 인수 배열과 `shell:false`로 Python·Semgrep을 실행한다. 자식 프로세스에는 OAuth·MySQL 비밀값을 전달하지 않는다. 규칙은 서버의 `security_rules/manual.yaml`과 `security_fixtures/cases.yaml`만 사용한다. 저장소에 포함된 규칙·설정은 로드하지 않는다. 결과의 경로·위치·개수·크기·분석 오류를 확인하고 원본 소스에서 코드 조각을 읽는다.

화면의 `결함 설명`은 Semgrep 결과의 `extra.message`를 DB의 `description`에 저장한 값이다. 이 문장은 Semgrep이 새로 생성하는 설명이 아니라 규칙 작성자가 YAML의 `message`에 넣은 문구다. 현재 일반 규칙과 샘플 규칙 모두 한국어로 작성했다. `야기될 문제`는 규칙의 `metadata.gitaegis_impact`에 작성한 유형별 위험 설명이다. AI 분석이나 개별 코드의 실제 영향 확정 결과는 아니다. 샘플에는 실제로 동작하지 않는 모형이라는 안내를 별도로 표시하고, 영향 설명은 같은 패턴을 실제 서비스에서 사용했을 때의 위험을 설명한다. 원본 코드·함수명·CWE 번호는 번역하지 않는다.

규칙 문구를 바꾼 뒤 기존 DB에도 적용하려면 `npm run db:sync-rule-copy`를 실행한다. 서버의 신뢰하는 규칙 ID와 일치하는 SAST 항목의 제목·설명·영향만 갱신하며 검사 이력·코드·취약점 상태는 유지한다. Semgrep 가상환경의 Python·ruamel.yaml과 DB 연결 설정이 필요하다. 재검사에서도 기존 항목의 영향 설명을 갱신한다.

## DB 설계

| 테이블 | 저장 내용 |
| --- | --- |
| `scans` | 저장소, manual 실행, SHA, 상태, 시작·완료 시각, SAST 건수, 실패 메시지, scan_scope |
| `vulnerabilities` | 저장소별 규칙·제목·등급·설명·영향·상태·최초/최근 탐지 시각 |
| `scan_findings` | 검사와 취약점의 연결, 파일 경로·시작/끝 줄·코드 조각 |

`scan_scope=sast`는 의존성 검사를 수행하지 않았음을 구분한다. `npm run db:init`은 기존 데이터에 손대지 않고 이 열이 없을 때 추가한다. 기존 기록의 범위는 `unknown`이다.

취약점의 fingerprint는 **규칙 ID + 파일 경로 + 시작 줄 + 코드**의 SHA-256이다. 같은 위치·코드를 다시 탐지하면 기존 취약점을 갱신하고 새 검사와 연결한다. `resolved`는 재발견 시 `open`으로 바꾸지만 오탐·위험 수용 상태는 유지한다. 줄이나 코드가 달라지면 별도 항목이 될 수 있다. 이번 검사에서 발견되지 않은 과거 항목을 자동 해결 처리하지 않는다.

분석 성공 후 결과 삽입과 완료 처리를 하나의 DB 트랜잭션으로 커밋한다. 실패하면 결과 저장을 롤백하고 검사 이력만 실패로 남긴다. 이전 결과를 삭제하거나 실패를 0건 성공으로 표시하지 않는다. 임시 폴더는 이번 호출에서 만든 `.tools/scans/run-*`인지 확인한 후 삭제한다.

## 실행 한도

| 항목 | 한도 |
| --- | --- |
| 압축 다운로드 | 25MB, 30초 |
| 압축 전체 파일 크기 합 | 100MB |
| 압축 항목 수 / 검사 소스 수 | 15,000 / 3,000 |
| 소스 한 파일 | 1MB |
| 압축 해제 / Semgrep 전체 시간 | 20초 / 90초 |
| Semgrep 작업 수 / 파일별 시간 / 메모리 옵션 | 1 / 5초 / 512MB |
| 결과 | 1,000건, JSON 16MB |

지원 파일이 없거나 분석 오류·한도 초과가 발생하면 실패로 남긴다. 일부만 분석한 결과를 전체 완료로 표시하지 않는다. Semgrep의 메모리 옵션은 OS 전체 자원 격리를 대신하지 않는다.

## 다른 PC와 OCI

현재 PC는 `.tools/semgrep` 가상환경을 준비했다. 이 폴더는 Git에 포함하지 않으므로 이전할 서버에서 별도로 설치한다. 검증에 사용한 Semgrep 버전은 1.181.0이다.

```bash
python -m venv .tools/semgrep
# Windows
.tools/semgrep/Scripts/python.exe -m pip install semgrep==1.181.0
# Linux: 위 설치 명령 대신
.tools/semgrep/bin/python -m pip install semgrep==1.181.0
```

기본 경로는 Windows의 `Scripts`, Linux의 `bin`을 자동 선택한다. 다른 위치에 설치하면 `.env.local`의 `SEMGREP_EXECUTABLE`, `SCAN_PYTHON_EXECUTABLE`에 실행 파일 절대 경로를 지정한다. 서버 사용자에게 실행 권한과 `.tools/scans` 쓰기 권한이 필요하다. 배포에는 `scripts/extract_scan_source.py`, `security_rules/manual.yaml`, `security_fixtures/cases.yaml`도 포함한다. OCI ARM64에서 설치·실행 검증은 별도로 필요하다.

현재 검사는 POST 요청 동안 동기 실행한다. Next 경로의 `maxDuration`은 180초이며 운영 프록시의 요청 제한도 이에 맞춰야 한다. 서버 중단은 진행 중 검사를 멈출 수 있다. 자동 검사·큐 기반 백그라운드 작업은 후속 구현 범위다.

## 검증

`npm run test:data`는 격리된 임시 MySQL DB와 테스트 전용 GitHub 압축 응답으로 **실제 Semgrep**을 실행한다. 샘플 5건+일반 규칙 1건, SHA·코드 저장, 재검사 중복 방지, 실행 잠금, 서버 중단 이력 복구, 잘못된 압축의 실패 기록을 확인한다. 실제 사용자 DB나 저장소를 수정하지 않는다.

`npm run test:scan-safety`는 압축 경로 이탈·링크·중복·용량·지원 파일 조건을 검증한다. `npm run test:fixtures`는 샘플 자체에 외부 시스템 동작이 없는지 확인한다.
