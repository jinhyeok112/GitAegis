# GitAegis

**GitHub 저장소의 소스 코드와 의존성을 분석하는 AI 보안 취약점 진단 서비스**

GitAegis는 저장소별 보안 위험을 모아 어느 저장소의 어느 코드가 왜 위험한지 확인하도록 돕는 심화응용프로젝트다.

현재 **GitHub OAuth 로그인, 공개·비공개 저장소 목록 조회, MySQL 저장소 연결·해제, 분석 설정 저장**을 구현했다. 화면에 가상 저장소나 검사 결과를 넣지 않는다. 취약점·검사 활동·구독·AI 사용량은 DB에 기록된 값만 표시하며, 기록이 없으면 빈 상태로 안내한다.

## 프로젝트 개요

| 항목 | 내용 |
| --- | --- |
| 프로젝트명 | GitAegis |
| 과제 | 2026년도 심화응용프로젝트 |
| 개발자 | 정진혁 · 202445071 |
| 소속 | 인하공업전문대학 컴퓨터시스템공학과 |
| 지도 교수 | 김철진 |
| 분야 | 웹소프트웨어, 정보보안, 네트워크, 데이터베이스 |

## 현재 동작

- 첫 접속에는 로그인 화면을 표시한다. GitHub 로그인 후 암호화된 HttpOnly 쿠키로 세션을 유지한다.
- 로그인할 때 `read:user user:email repo` 권한을 요청한다. 접근 가능한 공개·비공개 저장소를 모두 조회한다.
- 기존 OAuth 앱의 Client ID와 Secret을 그대로 사용한다. 별도 앱이나 API 키를 만들 필요가 없다.
- 사용자와 GitHub 사용자 ID를 MySQL에 저장한다. 액세스 토큰은 별도 키로 암호화해 서버 DB에만 보관한다.
- 저장소 메뉴에서 GitHub API의 전체 페이지를 읽고, 저장소명 검색과 공개·비공개 표시를 제공한다.
- 연결하기·연결 해제는 DB에 반영한다. 새로고침이나 서버 재시작 후에도 연결 상태가 유지된다.
- 연결 해제는 저장소와 기존 검사 기록을 삭제하지 않는다.
- 커밋 검사·정기 분석 설정을 DB에 저장한다. 실제 자동 실행기는 아직 연결하지 않았다.
- 대시보드는 사용자 소유의 DB 기록만 읽는다. 다른 사용자의 저장소와 검사 결과는 조회·변경할 수 없다.
- 구독이나 AI 사용 이력이 없으면 구독 없음·사용 기록 0회로 표시한다. 임의 요금이나 사용량을 넣지 않는다.
- `DB 설계 · 검토용` 메뉴에서는 현재 SQL 스키마와 테이블 관계를 확인한다.

GitHub OAuth의 `repo` 권한은 쓰기도 포함한다. 현재 애플리케이션의 GitHub 요청은 저장소 조회용 GET만 수행한다. 조직 저장소는 조직의 OAuth 앱 정책·SSO 승인이 추가로 필요할 수 있다.

## 아직 연결하지 않은 기능

- 저장소 복제와 실제 Semgrep 검사 실행
- NVD·CWE·OSV 등 취약점 정보 연동
- 커밋 웹훅 및 정기 검사 실행기
- Gemini를 통한 AI 설명과 수정 제안
- 실제 결제·청구
- OCI 운영 배포

저장소 연결은 검사 대상으로 등록하는 단계다. 연결만으로 검사가 실행되거나 저장소가 안전하다고 판정되지 않는다.

## 기술 구성

| 영역 | 현재 구현 / 계획 |
| --- | --- |
| 웹·서버 API | Next.js App Router, TypeScript, React, Tailwind CSS |
| 인증 | Auth.js, GitHub OAuth, JWT 쿠키 |
| DB | MySQL 8, mysql2 드라이버 |
| 분석 서버 | Python·FastAPI·Semgrep 연동 예정 |
| 취약점 정보 | NVD·MITRE CWE·OSV 연동 예정 |
| AI | Gemini 연동 예정 |
| 운영 | OCI Ampere A1 이전 예정 |

## 로컬 설정과 실행

Node.js 20.9 이상, npm, MySQL 8이 필요하다. `.env.example`을 참고해 `.env.local`을 준비한다. 실제 비밀값은 Git에 포함하지 않는다.

```dotenv
AUTH_URL=http://localhost:3000
AUTH_SECRET=생성한_랜덤값
AUTH_GITHUB_ID=GitHub_Client_ID
AUTH_GITHUB_SECRET=GitHub_Client_Secret
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=gitaegis
MYSQL_USER=DB계정
MYSQL_PASSWORD=DB비밀번호
GITHUB_TOKEN_ENCRYPTION_KEY=별도로_생성한_32바이트_base64url키
```

`AUTH_SECRET`과 `GITHUB_TOKEN_ENCRYPTION_KEY`는 각각 다음 명령으로 한 번 생성한다. 서버 재시작 시 같은 값을 유지한다.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

GitHub OAuth App의 설정:

| 항목 | 주소 |
| --- | --- |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

```bash
npm install
npm run db:init
npm run dev -- --hostname 127.0.0.1
```

`db:init`은 지정한 DB와 없는 테이블만 생성하며 기존 데이터를 삭제하지 않는다. 기존 구조 변경을 자동으로 수행하는 마이그레이션 도구는 아니다.

브라우저에서 `http://localhost:3000`에 접속한다. 로그인 후 저장소 메뉴를 열면 공개·비공개 목록을 불러온다. 저장소를 선택해 연결하면 연결 상태가 MySQL에 저장된다.

이전 버전에서 로그인한 세션은 토큰이나 새 저장소 권한이 없을 수 있다. 화면의 GitHub 저장소 권한 승인 버튼으로 한 번 다시 승인한다. 환경변수를 바꾸면 개발 서버를 재시작한다.

## 코드 구조

```text
auth.ts                                  인증과 GitHub 계정 저장
app/page.tsx                             인증 후 서버에서 DB 조회
app/api/auth/[...nextauth]/route.ts       OAuth·세션·로그아웃
app/api/dashboard/route.ts                사용자별 DB 데이터 조회
app/api/github/repositories/route.ts      실제 GitHub 목록 조회
app/api/repositories/route.ts             저장소 연결·해제
app/api/repositories/[id]/policy/route.ts  분석 설정 저장
lib/server/db.ts                         MySQL 연결 풀
lib/server/github-account.ts             사용자 및 암호화 토큰 저장
lib/server/token-encryption.ts            AES-256-GCM 토큰 암호화
lib/server/github.ts                      GitHub API와 페이지 처리
lib/server/dashboard-data.ts              DB 기록을 화면 데이터로 변환
lib/server/request-auth.ts                로그인·사용자 소유권·요청 출처 확인
lib/types.ts                             화면과 API의 데이터 타입
database/schema.sql                      테이블 10개와 외래키
scripts/db-init.mjs                       기존 데이터를 보존하는 초기화
```

자세한 코드 설명:

- [GitHub 로그인과 쿠키 세션](docs/authentication.md)
- [DB 및 저장소 연결 구조](docs/database-and-repositories.md)

## 검증

```bash
npm run lint
npm run build
npm run test:auth
npm run test:data
npm run test:fixtures
```

인증 검사는 로그인·쿠키 복원·만료·변조·CSRF·PKCE·state·repo 권한을 확인한다. 데이터 검사는 별도로 생성한 임시 MySQL DB에서 저장·사용자별 분리·정책 변경·연결 해제·서버 재시작 후 보존을 확인한다. GitHub API 응답은 테스트 프로세스 안에서만 대체하며, 애플리케이션에는 대체 데이터나 우회 경로를 두지 않는다. 테스트 종료 시 해당 테스트가 만든 DB만 삭제한다.

### 정적 분석용 안전 샘플

`security_fixtures/`에는 SQL 삽입·명령 삽입·경로 조작·HTML 삽입·외부 리다이렉트 패턴 5개와 안전한 비교 코드 5개를 둔다. 모두 메모리 안의 모형 API를 사용하며 실제 DB·명령·파일·네트워크 동작을 실행하지 않는다. 앱에서 불러오거나 가짜 검사 결과를 저장하지 않는다. 전용 Semgrep 규칙과 검증 방법은 [샘플 안내](security_fixtures/README.md)를 참고한다.

## 취약점 정보 연동 계획

패키지명·설치 버전과 [NVD API](https://nvd.nist.gov/developers/vulnerabilities)의 CPE·CVE 정보를 대조할 계획이다. 이름 검색만으로 영향 여부를 확정하지 않는다. 최소 수정 버전은 공급자의 보안 공지·릴리스로 확인한다.

코드 문제는 Semgrep 검사 결과와 규칙의 CWE 분류를 사용하고, [MITRE CWE API](https://github.com/CWE-CAPEC/REST-API-wg/blob/main/Quick%20Start.md)로 약점 설명을 가져올 계획이다. 설명 API 자체가 코드를 검사하지는 않는다.

## OCI 이전

OCI에서 MySQL 데이터를 백업·복원하고 동일 코드를 배포한다. `AUTH_URL`, DB 접속 정보, OAuth 콜백을 운영 도메인으로 변경하고 HTTPS를 구성한다. 토큰 복호화에 필요한 `GITHUB_TOKEN_ENCRYPTION_KEY`를 안전하게 이전한다. Ampere A1에서는 ARM64 호환 런타임과 분석 도구를 사용한다.
