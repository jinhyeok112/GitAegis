# GitHub 로그인과 쿠키 세션 구조

## 현재 구현 범위

첫 방문에는 로그인 화면을 표시한다. GitHub OAuth 승인을 완료하면 대시보드로 이동하고 실제 GitHub 이름과 사용자명을 표시한다. 세션 쿠키가 유효하면 새로고침하거나 브라우저를 종료했다가 다시 열어도 로그인 상태를 복원한다. 로그아웃하면 브라우저의 세션 쿠키를 삭제한다.

인증은 Next.js 서버에서 처리한다. 로그인 시 실제 GitHub 사용자를 MySQL에 저장하고 액세스 토큰은 별도 키로 암호화해 DB에 보관한다. GitHub 저장소 목록과 연결 상태는 실제 API 및 DB를 사용한다. 검사·구독·AI 사용량도 DB에 저장된 기록만 표시한다.

Next.js 16과 호환되는 Auth.js `next-auth@5.0.0-beta.32`를 사용한다. 버전은 `package.json`과 `package-lock.json`에 고정한다. OAuth 처리, CSRF 검증, 세션 암호화를 직접 재구현하지 않고 라이브러리에 맡긴다.

## 파일 구조와 책임

```text
auth.ts                              GitHub 공급자, 세션 수명, 공개 사용자 정보
app/api/auth/[...nextauth]/route.ts   Auth.js GET/POST 요청 처리
app/actions/auth.ts                  GitHub 로그인 시작 서버 액션
app/login/page.tsx                   로그인 화면과 실패 안내
components/login-button.tsx          로그인 요청 중 중복 클릭 방지
app/page.tsx                         서버에서 인증 후 대시보드 표시
components/dashboard.tsx             실제 사용자 표시, 세션 재확인, 로그아웃
types/next-auth.d.ts                  세션의 GitHub 사용자명 타입
.env.local                           로컬 비밀 설정, Git 추적 제외
.env.example                         비밀값 없는 설정 양식
tests/auth.integration.test.mjs       운영 빌드에 대한 HTTP 통합 검사
```

## 1. 첫 접속의 접근 제어

`app/page.tsx`는 서버 컴포넌트다. 브라우저에 대시보드를 보내기 전에 다음 코드를 실행한다.

```tsx
const session = await auth();
if (!session?.user) redirect("/login");
```

`auth()`는 요청에 포함된 쿠키를 읽고 복호화 및 만료 검증을 수행한다. 유효한 사용자 세션이 없으면 `/login`으로 이동한다. DB 설계 파일을 읽는 작업도 인증 검사 이후에 수행한다. 로그인 여부를 브라우저의 `useState(true)`나 `localStorage` 값으로 판단하지 않는다.

로그인 화면도 `auth()`로 세션을 확인한다. 로그인한 사용자가 `/login`을 열면 대시보드 `/`로 이동한다. 두 화면은 요청마다 세션을 읽는 동적 페이지이며 공용 정적 캐시에 사용자 화면을 저장하지 않는다.

## 2. GitHub OAuth 요청과 콜백

로그인 버튼의 `<form>`이 `app/actions/auth.ts`의 서버 액션을 호출한다.

```tsx
await signIn("github", { redirectTo: "/" });
```

이 코드는 GitHub 승인 페이지로 이동할 URL과 인증 과정에 필요한 임시 쿠키를 만든다. Client Secret을 로그인 버튼의 속성이나 브라우저 코드에 넣지 않는다.

`auth.ts`의 공급자 설정은 다음과 같다.

```ts
providers: [GitHub({ checks: ["pkce", "state"], authorization: { params: { scope: "read:user user:email repo" } } })],
```

`state`는 로그인 요청과 콜백을 같은 인증 시도로 묶는다. PKCE는 최초 요청에서 생성한 검증값을 가지고 있는 서버만 인증 코드를 교환하도록 돕는다. 로그인·로그아웃의 POST 요청에는 Auth.js 또는 Next.js 서버 액션의 CSRF 보호를 적용한다.

승인 이후 GitHub는 다음 주소로 브라우저를 돌려보낸다.

```text
http://localhost:3000/api/auth/callback/github
```

`app/api/auth/[...nextauth]/route.ts`가 콜백을 받는다.

```ts
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
```

이 하나의 경로가 GitHub 콜백뿐 아니라 `/api/auth/session`, `/api/auth/csrf`, `/api/auth/signout` 등도 처리한다. 라이브러리는 인증 코드를 GitHub 액세스 토큰으로 교환하고 GitHub 프로필을 조회한다. 검증이 성공해야 세션 쿠키를 발급한다. 기본 요청 권한은 `read:user user:email repo`이다. 로그인할 때 공개·비공개 저장소 접근 권한을 함께 요청한다. OAuth의 repo 권한은 쓰기도 포함하지만 현재 앱의 GitHub API 호출은 조회만 수행한다.

앞서 예로 든 FastAPI의 `http://localhost:8000/auth/github/callback`은 이번 구현에서 사용하지 않는다. 실제 콜백 처리를 Next.js가 담당하므로 GitHub 설정도 3000번 포트의 경로와 맞춰야 한다.

## 3. 쿠키로 로그인 유지

`auth.ts`의 핵심 설정은 다음과 같다.

```ts
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

session: { strategy: "jwt", maxAge: SESSION_MAX_AGE },
```

브라우저 로그인 유지에는 암호화된 JWT 세션을 사용하고, 영구 사용자 식별과 GitHub API 토큰은 MySQL에 보관한다. 단순히 사용자명을 쿠키에 저장하는 방식과 다르다. 서버는 `AUTH_SECRET`에서 파생한 키로 세션을 암호화하고 검증한다. 사용자 식별값이나 만료 시각을 임의로 바꾼 쿠키는 인증에 사용할 수 없다.

기본 세션 쿠키는 로컬 HTTP에서는 `authjs.session-token`, HTTPS에서는 `__Secure-authjs.session-token`이다. Auth.js의 기본 보안 옵션을 그대로 사용한다.

- `HttpOnly`: 브라우저 JavaScript가 세션 쿠키를 직접 읽지 못한다.
- `SameSite=Lax`: 외부 사이트에서 보내는 교차 사이트 요청의 쿠키 전송을 제한하면서 OAuth 복귀를 허용한다.
- `Path=/`: 사이트 전체 요청에서 같은 세션을 사용한다.
- `Expires`: 세션 발급 또는 갱신 시점으로부터 7일 뒤로 설정한다. 브라우저 재실행 이후에도 보존할 수 있다.
- `Secure`: HTTPS 주소에서는 HTTPS 요청에만 쿠키를 보낸다. 로컬 HTTP 개발에서는 비활성화된다.

브라우저는 이후 요청에 쿠키를 자동으로 보낸다. 서버를 재시작해도 `AUTH_SECRET`과 도메인이 같고 쿠키가 만료되지 않았다면 세션을 다시 읽을 수 있다. `AUTH_SECRET`을 매번 새로 생성하면 기존 로그인이 모두 무효화된다.

브라우저가 쿠키를 삭제했거나 시크릿 창을 닫았거나 만료 시간이 지났다면 다시 로그인해야 한다. 캐시를 지워서 인증 상태를 복구하는 방식은 사용하지 않는다.

## 4. 화면에서 사용하는 사용자 정보

`auth.ts`의 `jwt` 콜백은 GitHub 프로필의 `login`을 세션 토큰에 복사한다. `session` 콜백은 화면에 필요한 정보만 반환한다.

```ts
jwt({ token, profile }) {
  if (profile && typeof profile.login === "string") {
    token.githubLogin = profile.login;
  }
  return token;
},
session({ session, token }) {
  session.user.id = token.sub ?? "";
  session.user.githubLogin = typeof token.githubLogin === "string" ? token.githubLogin : "";
  return session;
},
```

GitHub의 액세스 토큰과 Client Secret을 브라우저에 전달하는 세션 객체에 넣지 않는다. `types/next-auth.d.ts`가 확장된 `session.user.id`와 `session.user.githubLogin`을 TypeScript에 알린다. 현재 `lib/server/github-account.ts`가 토큰을 암호화해 저장하고 `lib/server/github.ts`만 복호화한 토큰으로 GitHub API를 호출한다.

`components/dashboard.tsx`는 서버가 검증한 세션으로 `SessionProvider`를 초기화한다. 처음 화면을 표시할 때 사용자 정보를 받기 위한 추가 요청을 기다릴 필요가 없다.

```tsx
<SessionProvider session={session} refetchInterval={300}>
  <DashboardContent databaseDesign={databaseDesign} />
</SessionProvider>
```

이후에는 5분 간격 및 창에 다시 포커스할 때 세션을 확인한다. 세션 API를 호출하면 만료 시각을 다시 7일 뒤로 갱신한다. 따라서 로그인 유지는 최초 로그인에서 고정된 7일이 아니라 마지막 세션 갱신부터 7일 기준이다.

`useSession({ required: true, ... })`는 세션이 만료되거나 다른 탭에서 로그아웃하면 대시보드를 숨기고 로그인 화면으로 이동한다. 실제 접근 허용 여부는 계속 서버의 `auth()` 검사가 결정한다. 클라이언트 세션 확인은 이미 열린 화면의 상태를 맞추는 보조 기능이다.

## 5. 로그아웃

로그아웃 버튼은 다음 코드를 실행한다.

```tsx
await signOut({ redirectTo: "/login" });
```

Auth.js가 CSRF 토큰을 구하고 `/api/auth/signout`에 POST 요청을 보낸다. 서버는 세션 쿠키의 수명을 0으로 설정해 삭제하고 브라우저를 로그인 화면으로 보낸다. 같은 브라우저의 다른 탭에도 세션 변경을 알린다. 네트워크 오류로 삭제하지 못한 경우 화면에 재시도 안내를 표시한다.

현재 JWT 세션에는 중앙 세션 저장소가 없다. 다른 기기의 로그인 일괄 종료나 관리자에 의한 세션 강제 폐기가 필요하면 DB 세션 또는 서버의 폐기 목록을 추가해야 한다. 앱 로그아웃은 GitHub 계정 자체의 로그아웃이나 OAuth 앱 권한 철회를 뜻하지 않는다.

## 6. 로컬 실행 설정

`.env.local`에서 다음 서버 전용 변수를 설정한다. 이 파일은 `.gitignore`로 제외된다. 비밀키에 `NEXT_PUBLIC_` 접두사를 붙이면 안 된다.

```dotenv
AUTH_URL=http://localhost:3000
AUTH_SECRET=서버에서_생성한_충분히_긴_랜덤값
AUTH_GITHUB_ID=발급받은_Client_ID
AUTH_GITHUB_SECRET=발급받은_Client_Secret
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=gitaegis
MYSQL_USER=DB계정
MYSQL_PASSWORD=DB비밀번호
GITHUB_TOKEN_ENCRYPTION_KEY=별도로_생성한_32바이트_base64url키
```

새 환경에서 `AUTH_SECRET`을 한 번 생성하려면 다음 명령을 사용한다. 생성 결과를 `.env.local`에 저장하고 서버 재시작 시 유지한다.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

GitHub OAuth App에는 다음 값을 등록한다.

| 항목 | 값 |
| --- | --- |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

```bash
npm install
npm run db:init
npm run dev -- --hostname 127.0.0.1
```

브라우저에서 `http://localhost:3000`에 접속한다. 개발 중에는 `localhost`와 `127.0.0.1` 주소를 섞지 않는다. 쿠키는 호스트별로 구분되며 OAuth 복귀 주소와 로그인 시작 주소가 같아야 한다. 환경변수를 수정한 뒤에는 서버를 재시작한다.

Client ID나 Secret이 비어 있으면 로그인 버튼을 비활성화하고 안내를 표시한다. 모의 계정으로 인증을 우회하지 않는다.

## 7. 검증

```bash
npm run lint
npm run build
npm run test:auth
npm run test:data
```

통합 검사는 운영 빌드를 임시 포트에서 실행하며 테스트 전용 자격정보와 무작위 암호화 키를 사용한다. 실제 GitHub 계정과 로컬 비밀 설정을 사용하지 않는다.

검증 범위는 첫 접속의 접근 차단, 로그인 화면, 쿠키를 통한 사용자 복원, 반복 요청, 만료·변조 쿠키 거부, 7일 만료 시각과 쿠키 보안 옵션, GitHub 승인 URL의 콜백·PKCE·state·권한, CSRF 없는 로그아웃 거부, 정상 로그아웃, 인증 과정 없이 호출한 콜백 거부, 설정 누락 시 인증 우회 차단이다.

자동 검사는 GitHub에서 실제 승인을 누르고 코드를 교환하는 단계까지 실행하지 않는다. 최종 확인은 브라우저에서 GitHub 로그인, 새로고침, 브라우저 재실행, 로그아웃을 순서대로 수행한다.

## 8. OCI로 옮길 때

OCI에서도 Next.js 서버에 같은 코드를 배포한다. 운영 도메인의 HTTPS를 준비한 뒤 `AUTH_URL`과 GitHub OAuth App의 Homepage URL 및 Authorization callback URL을 운영 주소로 맞춘다. 개발용과 운영용 OAuth App을 분리하면 로컬 설정을 유지할 수 있다.

예를 들어 서비스 주소가 `https://서비스도메인`이면 콜백은 `https://서비스도메인/api/auth/callback/github`이다. Nginx가 요청을 Next.js로 전달하도록 구성한다. `AUTH_SECRET`은 OCI의 서버 환경변수나 비밀 관리 기능으로 주입한다. 로컬에서 OCI 도메인으로 바뀌면 브라우저 쿠키는 이전되지 않으므로 사용자는 운영 주소에서 다시 로그인한다.

## 공식 문서

- [Auth.js 설치와 Next.js 연결](https://authjs.dev/getting-started/installation)
- [GitHub 공급자 설정](https://authjs.dev/getting-started/providers/github)
- [JWT 세션과 DB 세션](https://authjs.dev/concepts/session-strategies)
- [Next.js 인증 가이드](https://nextjs.org/docs/app/guides/authentication)


사용자·저장소 DB 저장, 토큰 암호화, GitHub 재승인과 API 구조는 [DB 및 저장소 연결](database-and-repositories.md)을 참고한다.
