import "server-only";
import type { GitHubRepository } from "@/lib/types";
import { getGitHubAccount } from "@/lib/server/github-account";
import { ServiceError } from "@/lib/server/errors";

type GitHubRepoResponse = {
  id: number;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  permissions?: { pull?: boolean };
};

async function githubRequest(path: string, accessToken: string) {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "GitAegis" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ServiceError("GITHUB_UNAVAILABLE", "GitHub 연결이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.", 502);
  }
  if (response.status === 401) throw new ServiceError("GITHUB_RECONNECT_REQUIRED", "GitHub 인증이 만료됐습니다. 계정을 다시 연결해 주세요.", 409);
  if (response.status === 403 || response.status === 429) throw new ServiceError("GITHUB_ACCESS_DENIED", "GitHub API 요청 한도 또는 조직 접근 권한을 확인해 주세요.", 403);
  if (response.status === 404) throw new ServiceError("REPOSITORY_NOT_FOUND", "이 저장소에 접근할 수 없습니다.", 404);
  if (!response.ok) throw new ServiceError("GITHUB_UNAVAILABLE", "GitHub에서 저장소를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", 502);
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
