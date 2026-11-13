# OCI에서 GitAegis 설치와 삭제

Docker는 앱을 실행에 필요한 프로그램과 함께 이미지로 묶는다. 컨테이너는 그 이미지로 실제 실행되는 서비스다. Docker Compose는 `compose.yaml`에 적힌 서비스를 같이 시작하고 제거한다.

| 서비스 | 하는 일 |
| --- | --- |
| `proxy` | Caddy가 HTTPS 인증서를 발급받고 브라우저 요청을 `app`으로 전달 |
| `app` | Next.js 웹, Python·Semgrep 수동 검사, 수정안 작업 실행 |
| `db` | MySQL에 계정, 저장소, 검사 결과 저장. 데이터는 `db_data` 볼륨에 보관 |

볼륨은 컨테이너를 다시 만들어도 데이터가 남는 Docker 저장 공간이다. 처음 시작하면 DB를 준비한 뒤 앱이 스키마를 만들고 실행된다. 이후에도 시작할 때 스키마를 확인하며 기존 데이터를 유지한다. 외부로 공개하는 포트는 Caddy의 80과 443이다. 앱과 DB는 Compose 네트워크에서 통신한다.

## 1. OCI에서 준비하기

1. OCI 인스턴스에서 아래 명령을 실행해 운영체제, CPU, Docker 설치 여부를 확인한다. 노트북에 SSH 키가 없다면 콘솔의 **관리 → 실행 명령**에서도 확인할 수 있다. 실제 설치에는 서버 관리자 권한이 필요하다. Run Command로 작업한다면 비밀번호나 API 키를 스크립트와 출력에 넣지 않는다. [Oracle Run Command 안내](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/runningcommands.htm)

   ```bash
   cat /etc/os-release
   uname -m
   docker --version
   docker compose version
   ```

2. Docker가 없다면 서버 운영체제에 맞게 Docker Engine과 Compose 플러그인을 설치한다. 이 배포는 `docker compose` 기준이다. Oracle Linux라면 배포판과 버전을 확인하고 설치 방법을 정한다. Ubuntu는 [Docker Engine 설치 안내](https://docs.docker.com/engine/install/ubuntu/)에 Compose 설치가 포함돼 있다.
3. 운영 도메인의 DNS를 OCI 인스턴스의 공인 IP로 연결한다. OCI 보안 규칙과 서버 방화벽에서 TCP 80·443을 허용하고, 기존 웹 서버가 이 포트를 사용 중인지 확인한다. 이 구성을 그대로 쓰면 Caddy가 두 포트를 사용해 인증서를 발급하고 갱신한다. [Caddy HTTPS 안내](https://caddyserver.com/docs/automatic-https)
4. GitAegis 소스와 이번에 추가된 배포 파일을 서버의 전용 폴더에 가져온다. 아래 예시는 `/opt/gitaegis`에 파일이 있고, 서버 계정으로 해당 폴더에 접근할 수 있다고 가정한다. 비공개 저장소라면 읽기 권한이 있는 배포용 자격 증명으로 가져온다. Windows의 `node_modules`나 `.tools`는 옮길 필요가 없다.

## 2. 서비스 주소와 키 설정하기

서버에서 파일을 만들고 편집한다. 아래 `cp -n`은 이미 만든 `.env.oci`를 보존한다.

```bash
cd /opt/gitaegis
umask 077
cp -n .env.oci.example .env.oci
chmod 600 .env.oci
nano .env.oci
```

- `AUTH_URL`에는 실제 운영 주소를 `https://gitaegis.example.com` 형식으로 넣는다. 마지막 `/`는 생략한다.
- GitHub OAuth App에 같은 주소를 홈페이지로 설정하고, 콜백은 그 주소 뒤에 `/api/auth/callback/github`를 붙인다. Client ID와 Client Secret을 `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`에 넣는다. 기존 배포도 계속 쓴다면 운영용 OAuth App을 따로 두면 기존 콜백을 유지할 수 있다.
- `AUTH_SECRET`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`는 아래 첫 명령을 각각 실행해 별도 값으로 만든다. `GITHUB_TOKEN_ENCRYPTION_KEY`는 두 번째 명령으로 만든다. 기존 DB의 암호화된 GitHub 토큰을 가져온다면 기존 암호화 키를 그대로 사용한다.
- AI 수정안을 쓰려면 `OPENROUTER_API_KEY` 또는 `GEMINI_API_KEY`를 넣는다.

```bash
openssl rand -hex 32
openssl rand -base64 32 | tr -- '+/' '-_' | tr -d '=\n'
```

## 3. 실행하고 확인하기

아래 명령은 전용 폴더에서 실행한다. 서버 계정에 Docker 권한이 없다면 관리자 권한으로 실행한다. 첫 실행은 이미지를 내려받고 앱을 빌드한다.

```bash
docker compose --env-file .env.oci config --quiet
docker compose --env-file .env.oci up -d --build
docker compose --env-file .env.oci ps
docker compose --env-file .env.oci exec app /opt/semgrep/bin/semgrep --disable-version-check --version
```

브라우저로 운영 주소를 열고 GitHub 로그인 → 저장소 연결 → 수동 검사 → 결과 표시까지 확인한다. AI 키를 설정했다면 수정안도 확인한다. 시작에 실패하면 아래 로그를 확인한다. Git에서 새 버전을 가져온 뒤 `up -d --build`를 다시 실행하면 앱을 갱신하고 DB 볼륨을 재사용한다.

```bash
docker compose --env-file .env.oci logs --tail=100 db app proxy
```

## 4. 앱과 DB 데이터까지 제거하기

필요한 데이터는 먼저 백업한다. `.env.oci`와 배포 파일이 있는 전용 폴더에서 아래 명령을 실행한다. MySQL 데이터와 저장된 OAuth 토큰, 검사 기록, Caddy 인증서가 함께 삭제된다. 프로젝트 전용 앱 이미지도 지운다. [Docker Compose 삭제 명령](https://docs.docker.com/reference/cli/docker/compose/down/)

```bash
docker compose --env-file .env.oci down --volumes --remove-orphans
docker image rm gitaegis-app:local
docker volume ls --filter label=com.docker.compose.project=gitaegis
```

목록에 GitAegis 볼륨이 남아 있지 않은지 확인한 뒤 전용 폴더와 `.env.oci`를 삭제한다. 이 배포 전용으로 만든 DNS, OCI 방화벽 규칙, OAuth App이 있다면 콘솔에서 정리한다. Docker Engine, 공용 이미지, 이미지 빌드 캐시와 수동 백업은 별도로 관리한다. 부트 디스크 초기화는 필요 없다.
