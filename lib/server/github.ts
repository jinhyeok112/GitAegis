import "server-only";
import type { GitHubRepository } from "@/lib/types";
import { getGitHubAccount } from "@/lib/server/github-account";
import { ServiceError } from "@/lib/server/errors";
import { writeFile } from "node:fs/promises";
import { COMMIT_CHECK_INTERVAL_SECONDS } from "@/lib/scan-policy";

type GitHubRepoResponse = {
  id: number;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  permissions?: { pull?: boolean };
};

export class GitHubPollError extends ServiceError {
  constructor(code: string, message: string, status: number, public retryAfterSeconds: number) {
    super(code, message, status);
  }
}

async function githubResponse(path: string, accessToken: string, headers: Record<string, string> = {}) {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "GitAegis", ...headers },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ServiceError("GITHUB_UNAVAILABLE", "GitHub 연결이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.", 502);
  }
  if (response.status === 401) throw new GitHubPollError("GITHUB_RECONNECT_REQUIRED", "GitHub가 저장소 접근 인증을 거절했습니다. GitHub 권한을 다시 연결해 주세요.", 409, 3600);
  if (response.status === 403 || response.status === 429) {
    const retry = response.headers.get("retry-after");
    const retrySeconds = retry && !Number.isNaN(Number(retry)) ? Number(retry) : Math.ceil((Date.parse(retry ?? "") - Date.now()) / 1000);
    const resetSeconds = response.headers.get("x-ratelimit-remaining") === "0" ? Math.ceil(Number(response.headers.get("x-ratelimit-reset")) - Date.now() / 1000) : 0;
    throw new GitHubPollError("GITHUB_ACCESS_DENIED", "GitHub API 요청 한도 또는 조직 접근 권한을 확인해 주세요.", 403, Math.max(300, retrySeconds || 0, resetSeconds || 0));
  }
  if (response.status === 404) throw new GitHubPollError("REPOSITORY_NOT_FOUND", "이 저장소에 접근할 수 없습니다.", 404, 3600);
  if (response.status === 304) return response;
  if (!response.ok) throw new ServiceError("GITHUB_UNAVAILABLE", "GitHub에서 저장소를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", 502);
  return response;
}

async function githubRequest(path: string, accessToken: string) {
  const response = await githubResponse(path, accessToken);
  return response.json();
}

function repositoryDto(repo: GitHubRepoResponse): GitHubRepository {
  return { githubId: String(repo.id), name: repo.full_name, url: repo.html_url, visibility: repo.private ? "private" : "public", defaultBranch: repo.default_branch };
}

export async function listGitHubRepositories(userId: string) {
  const { accessToken, scope } = await getGitHubAccount(userId);
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows: GitHubRepoResponse[] = await githubRequest(`/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`, accessToken);
    repositories.push(...rows.map(repositoryDto));
    if (rows.length < 100) return { repositories, privateAccess: scope.split(/[ ,]+/).includes("repo") };
  }
  throw new ServiceError("TOO_MANY_REPOSITORIES", "저장소가 너무 많아 전체 목록을 불러오지 못했습니다.", 422);
}

export async function getAccessibleRepository(userId: string, githubId: string) {
  const { accessToken } = await getGitHubAccount(userId);
  const repo: GitHubRepoResponse = await githubRequest(`/repositories/${githubId}`, accessToken);
  if (!repo.permissions?.pull) throw new ServiceError("REPOSITORY_ACCESS_DENIED", "읽기 권한이 있는 저장소만 연결할 수 있습니다.", 403);
  return repositoryDto(repo);
}

export async function latestRepositoryCommit(userId: string, githubId: string, previous: { branch: string | null; etag: string | null }) {
  const repo = await getAccessibleRepository(userId, githubId);
  const { accessToken } = await getGitHubAccount(userId);
  const name = repo.name.split("/").map(encodeURIComponent).join("/");
  const headers: Record<string, string> = { Accept: "application/vnd.github.sha" };
  if (previous.branch === repo.defaultBranch && previous.etag) headers["If-None-Match"] = previous.etag;
  const response = await githubResponse(`/repos/${name}/commits/${encodeURIComponent(repo.defaultBranch)}`, accessToken, headers);
  const sha = response.status === 304 ? null : (await response.text()).trim();
  if (sha !== null && !/^[a-f0-9]{40}$/i.test(sha)) throw new ServiceError("INVALID_COMMIT", "기본 브랜치의 커밋을 확인하지 못했습니다.", 502);
  return { sha, branch: repo.defaultBranch, etag: response.headers.get("etag")?.slice(0, 255) ?? null,
    pollSeconds: Math.max(COMMIT_CHECK_INTERVAL_SECONDS, Number(response.headers.get("x-poll-interval")) || 0) };
}

export async function downloadRepositorySource(userId: string, githubId: string, archivePath: string, pushedSha?: string) {
  const repo = await getAccessibleRepository(userId, githubId);
  const { accessToken } = await getGitHubAccount(userId);
  const name = repo.name.split("/").map(encodeURIComponent).join("/");
  const sha = pushedSha ?? (await githubRequest(`/repos/${name}/commits/${encodeURIComponent(repo.defaultBranch)}`, accessToken)).sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) throw new ServiceError("INVALID_COMMIT", "기본 브랜치의 커밋을 확인하지 못했습니다.", 502);
  const controller = AbortSignal.timeout(30000);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "GitAegis" };
  let response = await fetch(`https://api.github.com/repos/${name}/tarball/${sha}`, { headers, redirect: "manual", cache: "no-store", signal: controller });
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get("location") || "");
    if (location.protocol !== "https:" || location.hostname !== "codeload.github.com") throw new ServiceError("INVALID_ARCHIVE_URL", "저장소 다운로드 주소를 확인하지 못했습니다.", 502);
    // A GitHub-provided signed archive URL needs no Authorization header.
    response = await fetch(location, { redirect: "error", cache: "no-store", signal: controller });
  }
  if (!response.ok || !response.body) throw new ServiceError("ARCHIVE_UNAVAILABLE", "저장소 소스를 다운로드하지 못했습니다. GitHub 권한을 확인해 주세요.", 502);
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 25 * 1024 * 1024) throw new ServiceError("ARCHIVE_TOO_LARGE", "압축된 저장소가 검사 한도인 25MB를 초과합니다.", 422);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  await writeFile(archivePath, Buffer.concat(chunks));
  return sha;
}
