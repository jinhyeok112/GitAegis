# MySQL 및 GitHub 저장소 연결

## 요청 흐름

로그인과 저장소 접근은 기존 GitHub OAuth 앱을 사용한다. 새 Client ID나 Secret이 필요하지 않다. 로그인할 때 `read:user user:email repo`를 요청하고 GitHub에서 승인을 받는다. `repo` 권한은 공개·비공개 저장소를 포함하고 쓰기도 허용하지만, 현재 앱은 GitHub API에 조회용 GET만 보낸다.

기존 로그인은 저장소용 토큰을 보관하지 않았으므로 한 번 다시 승인해야 한다. 저장소 메뉴는 인증된 사용자가 접근 가능한 공개·비공개 저장소를 자동으로 불러온다. GitHub 조직의 앱 차단이나 SSO 승인이 있으면 해당 조직의 정책도 충족해야 한다.

## 1. 인증과 사용자 식별

`auth.ts`의 JWT 콜백은 GitHub에서 실제 로그인한 프로필의 `id`를 읽는다. 사용자명은 변경될 수 있으므로 영구 소유권을 사용자명으로 판단하지 않는다.

```ts
const githubUserId = String(profile.id);
token.githubUserId = githubUserId;
token.sub = await saveGitHubAccount(profileData, account.access_token, account.scope ?? "");
```

`saveGitHubAccount()`는 트랜잭션에서 다음 두 작업을 함께 완료한다.

1. `users.github_user_id`의 고유 키로 사용자를 생성하거나 갱신한다. 내부 UUID는 재로그인 후에도 유지한다.
2. `github_accounts`에 암호화한 액세스 토큰과 승인된 권한을 저장한다.

실패하면 트랜잭션을 롤백한다. Client Secret과 액세스 토큰을 `session` 콜백의 공개 결과에 넣지 않는다. 브라우저 세션에는 사용자 ID·이름·GitHub 사용자명 등만 포함한다.

## 2. 토큰 암호화

`lib/server/token-encryption.ts`는 `GITHUB_TOKEN_ENCRYPTION_KEY`의 32바이트 키로 AES-256-GCM을 사용한다. 토큰을 저장할 때마다 새 12바이트 IV를 생성한다.

```text
v1.IV.인증태그.암호문
```

IV와 인증 태그는 비밀키가 아니다. 키는 `.env.local` 또는 운영 서버의 비밀 설정에만 둔다. DB 내용만 유출돼도 평문 토큰이 바로 노출되지 않도록 분리한다. GCM 인증 검증에 실패하면 GitHub 재연결을 요구한다.

암호화 키를 잃거나 새 키로 교체하면 기존 토큰을 복호화할 수 없으므로 다시 로그인해야 한다. OCI 이전 시 DB 백업과 이 키를 함께, 각각 안전하게 이전한다. JWT 세션의 `AUTH_SECRET`과 토큰 암호화 키는 서로 다른 키다.

## 3. MySQL 연결

`lib/server/db.ts`가 서버 전용 `mysql2/promise` 연결 풀을 생성한다. 최대 연결 수는 5개다. 개발 중 모듈이 다시 로드돼도 연결 풀이 계속 늘어나지 않도록 서버 전역에서 재사용한다.

SQL은 `execute(sql, parameters)`로 실행한다. 사용자 ID·저장소 ID·설정값을 문자열에 직접 결합하지 않는다. 예외의 원본 SQL이나 비밀번호를 응답에 넣지 않는다.

서버 연결에 필요한 환경변수:

```dotenv
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=gitaegis
MYSQL_USER=DB계정
MYSQL_PASSWORD=DB비밀번호
GITHUB_TOKEN_ENCRYPTION_KEY=32바이트_base64url키
```

`npm run db:init`은 DB와 없는 테이블을 생성한다. 샘플 데이터를 입력하거나 기존 데이터를 삭제하지 않는다. 운영에서는 애플리케이션용 제한 계정을 사용하고 스키마 변경 권한을 분리한다.

## 4. 저장소 목록 조회

`GET /api/github/repositories`는 로그인 세션으로 DB 사용자를 확인하고 그 사용자의 토큰만 복호화한다. 실제 GitHub 요청은 서버에서 수행한다.

```text
GET https://api.github.com/user/repos
Authorization: Bearer <서버에서 복호화한 토큰>
```

`affiliation=owner,collaborator,organization_member`, `per_page=100`, 페이지 번호를 사용해 본인·협업·조직 저장소의 목록을 끝까지 읽는다. 공개·비공개 구분은 응답의 `private`에서 가져온다. 첫 페이지 100개만 반환하지 않는다. 비정상적으로 큰 목록은 오류를 반환하며 전체 목록인 것처럼 일부만 표시하지 않는다.

브라우저에는 GitHub 저장소 ID·전체 이름·주소·공개 여부·기본 브랜치만 전달한다. 토큰은 전달하지 않고 응답 캐시는 `private, no-store`로 제한한다. API 한도·인증 만료·권한 부족·연결 지연은 빈 목록 대신 오류로 안내한다.

## 5. 저장소 연결과 해제

브라우저는 다음 본문만 보낸다. 인증값이나 사용자 ID를 URL에 넣지 않는다.

```json
{ "githubRepositoryId": "GitHub의 숫자 ID", "connected": true }
```

`POST /api/repositories`는 로그인과 요청 출처를 검사한다. 연결할 때는 GitHub API에서 해당 저장소를 다시 조회하고 읽기 권한을 확인한다. 클라이언트가 보낸 저장소 이름이나 소유자 정보는 신뢰하지 않는다.

DB의 `(user_id, github_repository_id)` 고유 키로 연결을 생성하거나 갱신한다. GitHub 저장소 ID는 이름 변경 이후에도 같은 저장소를 구분한다. 내부 `repositories.id` UUID는 검사와 취약점의 외래키에 사용한다.

해제할 때는 `connected = FALSE`만 저장한다. 검사 이력·취약점·분석 설정을 삭제하지 않는다. 다시 연결해도 이전 UUID와 정책을 유지한다. 연결 작업은 DB 저장이 성공한 뒤 화면에 반영하므로 실패한 요청을 성공처럼 표시하지 않는다.

## 6. 사용자별 데이터 분리

모든 데이터 API는 서명된 로그인 세션의 GitHub 사용자 ID로 DB 사용자를 찾는다. 요청 본문에 다른 `userId`를 넣어도 소유자가 바뀌지 않는다.

조회에는 `WHERE repositories.user_id = ?`, 정책 변경에는 `WHERE id = ? AND user_id = ? AND connected = TRUE` 조건을 사용한다. 다른 사용자의 저장소 UUID를 알아도 조회하거나 수정할 수 없다.

POST·PUT에는 `Origin` 검사와 JSON 본문 검증을 적용한다. 쿠키가 첨부된 교차 사이트 요청도 출처가 다르면 거절한다.

## 7. 실제 기록만 표시하는 대시보드

`app/page.tsx`는 인증 후 MySQL 데이터를 읽어 초기 화면에 전달한다. `lib/server/dashboard-data.ts`가 현재 사용자에게 속한 저장소·검사·취약점·최근 활동·구독·AI 사용량을 조회한다.

기록이 없으면 빈 목록이나 실제 집계값 0을 표시한다. DB 장애는 별도 오류 상태로 표시하며 정상적인 0건으로 바꾸지 않는다. 취약점 결과가 없다는 사실을 저장소가 안전하다는 뜻으로 표현하지 않는다.

`lib/mock-data.ts`와 그 참조를 삭제했다. 가짜 저장소, 코드, CVE 결과, AI 수정안, 차트, 유료 계정 상태, 사용 횟수를 입력하지 않는다. 실제 분석·결제 기능을 연결하기 전에는 해당 DB 기록이 생성되지 않는다.

## 8. 분석 설정 저장

`PUT /api/repositories/[id]/policy`는 주기·요일·시각·불리언 값·시간대를 검증하고 해당 사용자 소유의 연결된 저장소에만 저장한다. UI는 저장 중 중복 클릭을 막고 실패하면 입력값을 유지한다.

설정 보존과 자동 검사 실행은 다른 기능이다. 현재는 정책을 DB에 저장하지만 웹훅·스케줄러·Semgrep 실행기를 구현하지 않았으므로 실제 검사를 예약하거나 실행하지 않는다. 이 제한은 화면에도 표시한다.

## 9. 검증 방법

```bash
npm run lint
npm run build
npm run test:auth
npm run test:data
```

데이터 통합 검사는 운영 DB와 다른 임시 DB를 생성하고 실제 MySQL에 저장·조회한다. 사용자별 데이터 분리, CSRF 출처 검사, GitHub 페이지 처리, 토큰 미노출, 연결·해제, 정책 검증, 검사 데이터 매핑, 서버 재시작 후 유지, DB 장애 응답을 확인한다.

테스트에서만 GitHub 응답을 대체한다. 프로덕션 코드에는 대체 API 주소나 인증 우회 모드를 넣지 않는다. 테스트가 만든 임시 DB만 종료 시 정리한다. 실제 계정의 권한·공개·비공개 목록은 사용자가 로그인 승인을 마친 뒤 실제 GitHub API로 별도 확인한다.

## 공식 문서

- [GitHub 저장소 API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
- [OAuth 권한 범위](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [mysql2 연결 풀](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool)
