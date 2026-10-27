# Vercel 배포와 GitHub 로그인 설정

서비스 주소는 `https://gitaegis.vercel.app`이다. 로컬 `.env.local`은 Git에서 제외하므로 커밋·푸시해도 Vercel에 전달되지 않는다. 비밀값을 소스 코드나 `NEXT_PUBLIC_` 변수로 옮기지 않는다.

## 1. Production 환경변수

Vercel에서 GitAegis 프로젝트의 **Settings → Environment Variables**를 열고 **Production** 환경에 다음 값을 등록한다. Preview 배포를 사용할 경우 해당 환경의 주소와 OAuth 콜백도 별도로 맞춘다.

| 변수 | 설정할 내용 |
| --- | --- |
| `AUTH_URL` | `https://gitaegis.vercel.app` |
| `AUTH_GITHUB_ID` | 사용할 GitHub OAuth App의 Client ID |
| `AUTH_GITHUB_SECRET` | 같은 OAuth App의 Client Secret |
| `AUTH_SECRET` | 해당 배포에서 계속 유지할 충분히 긴 무작위 비밀값 |

`AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_SECRET` 중 하나라도 비어 있으면 로그인 화면은 버튼을 비활성화한다. 인증 API도 설정 오류를 반환할 수 있다. 잠시 기다리거나 코드만 다시 푸시하는 것으로는 누락된 설정이 채워지지 않는다.

환경변수를 저장한 뒤 새 Production 배포를 실행한다. 기존 배포는 환경변수 변경만으로 갱신되지 않는다. Git 연동을 사용하는 경우 Production 브랜치의 새 커밋으로 배포하거나 Deployments에서 Redeploy를 실행한다.

## 2. GitHub OAuth 콜백

위의 Client ID에 해당하는 OAuth App의 허용 콜백에 다음 주소가 등록되어 있어야 한다.

```text
https://gitaegis.vercel.app/api/auth/callback/github
```

Homepage URL도 운영 서비스 주소를 사용한다. 로컬 개발 콜백은 `http://localhost:3000/api/auth/callback/github`이다. 개발용과 운영용 앱을 분리하거나, 같은 앱을 사용하는 경우 실제 사용하는 콜백 주소들을 OAuth App 설정에서 관리한다. 새 앱을 사용하면 그 앱의 ID와 Secret을 한 쌍으로 설정한다.

## 3. 사용자·저장소 데이터를 저장할 DB

로그인 설정과 데이터베이스 설정은 별개다. 현재 서비스는 MySQL에 사용자와 암호화된 GitHub 토큰, 저장소 및 검사 결과를 보관한다.

| 변수 | 설정할 내용 |
| --- | --- |
| `MYSQL_HOST` | Vercel에서 접근할 수 있는 운영 MySQL 서버 주소 |
| `MYSQL_PORT` | 운영 DB 포트 |
| `MYSQL_DATABASE` | 운영 DB 이름 |
| `MYSQL_USER` | 애플리케이션용 DB 계정 |
| `MYSQL_PASSWORD` | 해당 DB 계정의 비밀번호 |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | 토큰 암호화에 사용할 32바이트 base64url 키 |

Vercel의 `127.0.0.1`이나 `localhost`는 개발 PC의 MySQL을 가리키지 않는다. 운영 DB 연결과 접근 제어를 별도로 준비하고, 해당 DB에 `database/schema.sql`의 스키마를 적용한다. 기존 암호화 토큰이 있는 DB를 이전한다면 같은 `GITHUB_TOKEN_ENCRYPTION_KEY`를 유지해야 한다.

## 4. 배포 확인 순서

1. `/login`에서 설정 오류 안내가 사라지고 로그인 버튼이 활성화되는지 확인한다.
2. `/api/auth/providers`가 HTTP 200을 반환하며 GitHub 제공자를 포함하는지 확인한다.
3. 로그인 요청의 GitHub `redirect_uri`가 위 운영 콜백과 일치하는지 확인한다.
4. GitHub 인증을 마친 뒤 대시보드가 열리는지 확인한다.
5. 저장소 목록 조회와 연결 상태 저장을 확인한다. DB 또는 토큰 암호화 설정이 빠져 있으면 이 단계는 동작하지 않을 수 있다.

실제 로그인 전에는 1~3단계까지만 확인할 수 있다. 단순히 로그인 페이지가 HTTP 200을 반환한다고 인증 성공으로 판단하지 않는다.

## 5. 수동 분석 실행 환경

현재 수동 분석기는 Python·Semgrep 실행 파일과 임시 폴더를 사용하는 서버 프로세스다. 로컬 `.tools/semgrep` 환경은 Git에 포함하지 않는다. 따라서 GitHub에 소스를 푸시하는 것만으로 Vercel에서 분석 도구가 설치되거나 실행되는 것은 아니다. 분석 실행은 별도 서버 환경을 준비해 검증해야 한다. 현재 설치·한도·이전 절차는 [수동 검사 안내](manual-scans.md)를 참고한다.

## 참고

- [Vercel 환경변수](https://vercel.com/docs/environment-variables)
- [Vercel 재배포](https://vercel.com/docs/deployments/managing-deployments)
- [GitHub OAuth 인증과 콜백](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
