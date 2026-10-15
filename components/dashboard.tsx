"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "next-auth";
import { SessionProvider, signOut, useSession } from "next-auth/react";
import ActivityChart from "@/components/activity-chart";
import AnalysisSettings from "@/components/analysis-settings";
import DatabaseDesignView from "@/components/database-design";
import type { DatabaseDesign } from "@/lib/database-design";
import VulnerabilityDetail from "@/components/vulnerability-detail";
import type { DashboardData, GitHubRepository, ScanPolicy, Vulnerability } from "@/lib/types";
import { loginWithGitHub } from "@/app/actions/auth";

type View = "overview" | "repositories" | "analysis" | "vulnerabilities" | "account" | "database";
type IconName = "shield" | "grid" | "repo" | "calendar" | "alert" | "usage" | "search" | "chevron" | "lock" | "check" | "close" | "logout";
const paths: Record<IconName, string> = {
  shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M9 12l2 2 4-4",
  grid: "M3 3h7v7H3Z M14 3h7v7h-7Z M3 14h7v7H3Z M14 14h7v7h-7Z",
  repo: "M4 5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1-2-2V5Z M4 17h16 M8 7h8 M8 11h5",
  calendar: "M4 5h16v16H4z M4 9h16 M8 3v4 M16 3v4 M8 13h3 M8 17h3",
  alert: "M12 3 2 20h20L12 3Z M12 9v5 M12 17v.1",
  usage: "M4 20V10 M10 20V4 M16 20v-8 M22 20H2",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M15 15l6 6",
  chevron: "m9 5 7 7-7 7",
  lock: "M6 10h12v11H6Z M8 10V6a4 4 0 0 1 8 0v4",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12 M18 6 6 18",
  logout: "M9 3H4v18h5 M10 12h11 M17 8l4 4-4 4",
};
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const menu: { id: View; label: string; icon: IconName }[] = [
  { id: "overview", label: "대시보드", icon: "grid" },
  { id: "repositories", label: "저장소", icon: "repo" },
  { id: "analysis", label: "분석 설정", icon: "calendar" },
  { id: "vulnerabilities", label: "취약점", icon: "alert" },
  { id: "account", label: "계정 및 사용량", icon: "usage" },
  // Temporary professor review entry: remove this entry to hide the design screen.
  { id: "database", label: "DB 설계 · 검토용", icon: "grid" },
];
const severityLabel = { critical: "치명적", high: "높음", medium: "중간", low: "낮음", info: "정보" };
const statusLabel = { new: "새로 발견", open: "미해결", triaging: "검토 중", resolved: "해결", false_positive: "오탐", accepted_risk: "위험 수용" };
const scanStatusLabel = { queued: "대기", running: "검사 중", completed: "완료", failed: "실패", canceled: "취소" };

export default function Dashboard({ databaseDesign, session, initialData, initialError }: { databaseDesign: DatabaseDesign; session: Session; initialData: DashboardData | null; initialError: string }) {
  return <SessionProvider session={session} refetchInterval={300}><DashboardContent databaseDesign={databaseDesign} initialData={initialData} initialError={initialError} /></SessionProvider>;
}

function DashboardContent({ databaseDesign, initialData, initialError }: { databaseDesign: DatabaseDesign; initialData: DashboardData | null; initialError: string }) {
  const { data: session, status } = useSession({
    required: true,
    onUnauthenticated() { window.location.replace("/login"); },
  });
  const user = session?.user;
  const displayName = user?.name || user?.githubLogin || "GitHub 사용자";
  const initial = Array.from(displayName)[0]?.toUpperCase() ?? "G";
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<DashboardData | null>(initialData);
  const [dataError, setDataError] = useState(initialError);
  const [githubRepositories, setGitHubRepositories] = useState<GitHubRepository[]>([]);
  const [githubLoading, setGitHubLoading] = useState(false);
  const [githubError, setGitHubError] = useState("");
  const [pendingRepository, setPendingRepository] = useState<string | null>(null);
  const repositories = data?.repositories ?? [];
  const scanPolicies = data?.scanPolicies ?? {};
  const scans = data?.scans ?? [];
  const vulnerabilities = data?.vulnerabilities ?? [];
  const [search, setSearch] = useState("");
  const [findingKind, setFindingKind] = useState("all");
  const [repositoryId, setRepositoryId] = useState("all");
  const [selected, setSelected] = useState<Vulnerability | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const loadData = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    const result = await response.json();
    if (response.status === 401) { window.location.replace("/login"); return; }
    if (!response.ok) throw new Error(result.error || "데이터를 불러오지 못했습니다.");
    setData(result);
    setDataError("");
  }, []);
  const loadGitHubRepositories = useCallback(async () => {
    setGitHubLoading(true);
    setGitHubError("");
    try {
      const response = await fetch("/api/github/repositories", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "저장소를 불러오지 못했습니다.");
      setGitHubRepositories(result.repositories);
    } catch (error) { setGitHubError(error instanceof Error ? error.message : "저장소를 불러오지 못했습니다."); }
    finally { setGitHubLoading(false); }
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [selected]);
  const recordedRepositoryIds = new Set([...scans.map(scan => scan.repositoryId), ...vulnerabilities.map(item => item.repositoryId)]);
  const connectedRepositories = repositories.filter(repo => repo.connected);
  const historyRepositories = repositories.filter(repo => !repo.connected && recordedRepositoryIds.has(repo.id));
  const selectableRepositories = [...connectedRepositories, ...historyRepositories];
  const availableRepositories = [...githubRepositories, ...repositories.filter(repo => !githubRepositories.some(remote => remote.githubId === repo.githubId))];
  const filteredRepos = availableRepositories.filter(repo => repo.name.toLowerCase().includes(search.toLowerCase()));
  const filteredVulnerabilities = vulnerabilities.filter(item => selectableRepositories.some(repo => repo.id === item.repositoryId) && (repositoryId === "all" || item.repositoryId === repositoryId) && (findingKind === "all" || (findingKind === "dependency" ? Boolean(item.dependency) : !item.dependency)));
  const needsReview = vulnerabilities.filter(item => item.status !== "resolved" && item.status !== "false_positive" && item.status !== "accepted_risk");
  const codeFindings = needsReview.filter(item => !item.dependency);
  const packageFindings = needsReview.filter(item => item.dependency);
  const activeScans = scans.filter(scan => scan.status === "queued" || scan.status === "running");
  const filteredScans = scans.filter(scan => selectableRepositories.some(repo => repo.id === scan.repositoryId) && (repositoryId === "all" || scan.repositoryId === repositoryId)).sort((a, b) => Number(!repositories.find(repo => repo.id === a.repositoryId)?.connected) - Number(!repositories.find(repo => repo.id === b.repositoryId)?.connected));

  function navigate(next: View) { setView(next); setSearch(""); if (next === "vulnerabilities") setFindingKind("all"); if (next === "repositories" && data?.github.connected) void loadGitHubRepositories(); }
  function openFindings(kind: string) { setView("vulnerabilities"); setFindingKind(kind); setRepositoryId("all"); }
  function repoName(id: string) { return repositories.find(repo => repo.id === id)?.name ?? "저장소"; }
  async function toggleRepository(githubId: string) {
    setPendingRepository(githubId);
    setGitHubError("");
    try {
      const stored = repositories.find(repo => repo.githubId === githubId);
      const response = await fetch("/api/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ githubRepositoryId: githubId, connected: !stored?.connected }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "저장소 연결을 변경하지 못했습니다.");
      await loadData();
      if (stored && repositoryId === stored.id && !recordedRepositoryIds.has(stored.id)) setRepositoryId("all");
    } catch (error) { setGitHubError(error instanceof Error ? error.message : "저장소 연결을 변경하지 못했습니다."); }
    finally { setPendingRepository(null); }
  }
  async function savePolicy(id: string, policy: ScanPolicy) {
    const response = await fetch(`/api/repositories/${encodeURIComponent(id)}/policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(policy) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "분석 설정을 저장하지 못했습니다.");
    await loadData();
  }
  async function logout() {
    setLoggingOut(true);
    setLogoutError(false);
    try {
      // Auth.js obtains a CSRF token, clears the cookie on the server, and
      // notifies other tabs before redirecting to the login screen.
      await signOut({ redirectTo: "/login" });
    } catch {
      setLogoutError(true);
      setLoggingOut(false);
    }
  }

  function repositoryFilter() {
    return <label className="repository-filter"><span>저장소</span><select aria-label="저장소 선택" value={repositoryId} onChange={event => setRepositoryId(event.target.value)}><option value="all">저장소 전체</option>{connectedRepositories.length > 0 && <optgroup label="연결된 저장소">{connectedRepositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</optgroup>}{historyRepositories.length > 0 && <optgroup label="연결 해제 · 기록 보관">{historyRepositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</optgroup>}</select></label>;
  }

  function findingsPanel() {
    return <section className="panel findings-panel" aria-labelledby="findings-title"><div className="panel-heading"><div><h2 id="findings-title">{view === "overview" ? "최근 취약점" : "취약점 목록"}</h2><p>발견된 문제를 확인하고 파일과 코드 위치를 검토하세요.</p></div><span className="result-count">{filteredVulnerabilities.length}건</span></div>
      {selectableRepositories.filter(repo => repositoryId === "all" || repo.id === repositoryId).map(repo => {
        const items = filteredVulnerabilities.filter(item => item.repositoryId === repo.id);
        if (items.length === 0 && repositoryId === "all") return null;
        return <section className="finding-group" key={repo.id} aria-label={`${repo.name} 취약점`}><div className="group-heading"><Icon name="repo" size={17} /><h3>{repo.name}</h3>{!repo.connected && <span className="history-label">기록만 보관</span>}<span>{items.length}건</span></div>{items.length === 0 ? <p className="empty-state">이 저장소에서 발견된 취약점이 없습니다.</p> : items.map(item => <button className="finding-row" key={item.id} onClick={() => setSelected(item)}><span className={`severity severity-${item.severity}`}>{severityLabel[item.severity]}</span><span className="finding-main"><strong>{item.title}</strong>{item.dependency && <span className="dependency-summary"><b>{item.dependency.packageName}@{item.dependency.installedVersion}</b><span className="dependency-upgrade">{item.dependency.fixedVersion ? `${item.dependency.fixedVersion} 이상으로 업그레이드` : "수정 버전 미공개"}</span></span>}<span className="finding-file">{item.filePath}{item.startLine !== null && ` · ${item.startLine}–${item.endLine}행`}</span></span><span className="finding-state">{statusLabel[item.status]}</span><Icon name="chevron" size={17} /></button>)}</section>;
      })}
      {filteredVulnerabilities.length === 0 && repositoryId === "all" && <p className="empty-state">저장된 취약점 결과가 없습니다. 아직 검사하지 않은 저장소의 안전성을 의미하지는 않습니다.</p>}
    </section>;
  }

  if (status !== "authenticated" || !user) return <main className="login-screen"><p role="status">로그인 상태를 확인하고 있습니다.</p></main>;
  if (!data) return <main className="login-screen"><section className="login-card"><h1>{dataError ? "데이터를 불러오지 못했습니다" : "데이터를 불러오고 있습니다"}</h1><p role={dataError ? "alert" : "status"}>{dataError || "DB 연결 상태와 계정 정보를 확인하고 있습니다."}</p>{dataError && <button className="button primary" onClick={() => { setDataError(""); void loadData().catch(error => setDataError(error.message)); }}>다시 시도</button>}<button className="button secondary" onClick={logout} disabled={loggingOut}>로그아웃</button></section></main>;

  return <div className="workspace">
    <aside className="sidebar"><button className="brand" onClick={() => navigate("overview")} aria-label="GitAegis 대시보드"><span className="brand-symbol"><Icon name="shield" size={22} /></span>GitAegis</button><nav aria-label="주요 메뉴">{menu.map(item => <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav><div className="sidebar-bottom"><button className="profile" onClick={() => navigate("account")}><span className="avatar">{initial}</span><span><strong>{displayName}</strong><small>@{user.githubLogin}</small></span><Icon name="chevron" size={16} /></button></div></aside>

    <main className="main-content"><header className="page-header"><div><h1>{view === "overview" ? "보안 대시보드" : view === "repositories" ? "Git 저장소 가져오기" : menu.find(item => item.id === view)?.label}</h1><p>{view === "overview" ? "발견된 보안 문제와 검사 추이를 확인하세요." : view === "repositories" ? "검사할 GitHub 저장소를 선택하세요." : view === "analysis" ? "저장소별 커밋 검사와 정기 분석 일정을 설정하세요." : view === "account" ? "GitHub 연결, AI 사용량과 스캔 기록을 관리하세요." : view === "database" ? "교수님 검토용 · 테이블 관계와 데이터 구조를 확인하세요." : "저장소별로 발견된 취약점을 확인하세요."}</p></div><span className="status-pill">DB 연결됨</span></header>
      {dataError && <p className="data-error" role="alert">{dataError}</p>}
      {(!data.github.connected || !data.github.privateAccess) && <section className="panel github-connect"><h2>GitHub 저장소 권한 연결</h2><p>공개·비공개 저장소를 모두 불러오려면 GitHub에서 저장소 접근을 한 번 승인해 주세요.</p><form action={loginWithGitHub}><button className="button primary">GitHub 저장소 권한 승인</button></form><small>GitHub OAuth의 repo 권한에는 쓰기도 포함됩니다. 현재 서비스는 저장소 조회만 수행합니다.</small></section>}

      {view === "overview" && <>
        <section className="dashboard-summary" aria-label="확인할 항목">
          <article className="panel action-card"><h2>검토할 코드</h2><div className="action-value">{codeFindings.length}<span>건</span></div><p>코드 위치와 위험 설명을 확인하세요.</p><button className="action-link" onClick={() => openFindings("code")}>코드 취약점 확인 <Icon name="chevron" size={15} /></button></article>
          <article className="panel action-card"><h2>업데이트할 패키지</h2><div className="action-value">{packageFindings.length}<span>개</span></div><p>{packageFindings[0]?.dependency ? `${packageFindings[0].dependency.packageName} ${packageFindings[0].dependency.installedVersion} · 수정 버전 ${packageFindings[0].dependency.fixedVersion ?? "미공개"}` : "업데이트가 필요한 패키지가 없습니다."}</p><button className="action-link" onClick={() => openFindings("dependency")}>업그레이드 안내 <Icon name="chevron" size={15} /></button></article>
          <article className="panel action-card"><h2>진행 중인 검사</h2><div className="action-value">{activeScans.length}<span>건</span></div><p>{activeScans[0] ? repoName(activeScans[0].repositoryId) : "진행 중인 검사가 없습니다."}</p><button className="action-link" onClick={() => navigate("account")}>검사 상태 확인 <Icon name="chevron" size={15} /></button></article>
        </section>
        <div className="dashboard-grid">
          <section className="panel dashboard-findings"><div className="panel-heading"><h2>최근 취약점</h2><button className="action-link" onClick={() => openFindings("all")}>전체 보기 <Icon name="chevron" size={15} /></button></div>
            {vulnerabilities.slice(0, 5).map(item => <button key={item.id} className="recent-finding" onClick={() => setSelected(item)}><span className={`severity severity-${item.severity}`}>{severityLabel[item.severity]}</span><span className="recent-finding-main"><strong>{item.dependency ? `${item.dependency.packageName} · ${item.dependency.advisoryId}` : item.title}</strong><span><Icon name="repo" size={13} />{repoName(item.repositoryId)}</span></span><Icon name="chevron" size={16} /></button>)}
            <div className="recent-footer">{vulnerabilities.length ? "취약점을 선택하면 코드 위치 또는 수정 버전을 확인할 수 있습니다." : "저장된 검사 결과가 없습니다. 실제 검사가 실행되면 결과를 표시합니다."}</div>
          </section>
          <ActivityChart days={data.activity} />
        </div>
      </>}
      {view === "vulnerabilities" && <><div className="filter-toolbar">{repositoryFilter()}<label className="repository-filter"><span>종류</span><select aria-label="취약점 종류" value={findingKind} onChange={event => setFindingKind(event.target.value)}><option value="all">취약점 전체</option><option value="code">코드 취약점</option><option value="dependency">의존성 취약점</option></select></label></div>{findingsPanel()}</>}

      {view === "analysis" && <AnalysisSettings repositories={connectedRepositories} scans={scans} policies={scanPolicies} onSave={savePolicy} onOpenRepositories={() => navigate("repositories")} />}
      {view === "database" && <DatabaseDesignView design={databaseDesign} />}

      {view === "repositories" && <section><div className="repository-toolbar"><div className="account-select"><Icon name="repo" /><span>@{user.githubLogin}</span><span className="connection-text">공개·비공개 저장소</span></div><label className="search-field"><Icon name="search" /><input aria-label="저장소 검색" placeholder="저장소 검색" value={search} onChange={event => setSearch(event.target.value)} /></label></div>{data.github.connected && <div className="repository-actions"><button className="button secondary" disabled={githubLoading} onClick={() => void loadGitHubRepositories()}>{githubLoading ? "불러오는 중…" : "목록 새로고침"}</button></div>}{githubError && <p className="data-error" role="alert">{githubError}</p>}<div className="panel import-list">{filteredRepos.map(repo => {
        const stored = repositories.find(item => item.githubId === repo.githubId);
        return <div className="import-row" key={repo.githubId}><span className="repo-avatar">{repo.name[0].toUpperCase()}</span><span className="import-name"><strong><a href={repo.url} target="_blank" rel="noopener noreferrer">{repo.name}</a></strong><span><Icon name="lock" size={13} />{repo.visibility === "private" ? "비공개" : "공개"} · {stored?.connected ? "연결됨" : stored && recordedRepositoryIds.has(stored.id) ? "연결 해제 · 기록 보관" : "연결 가능"}</span></span><button className={`button ${stored?.connected ? "secondary" : "primary"}`} disabled={pendingRepository !== null} onClick={() => void toggleRepository(repo.githubId)}>{pendingRepository === repo.githubId ? "저장 중…" : stored?.connected ? "연결 해제" : "연결하기"}</button></div>;
      })}{!githubLoading && !githubError && filteredRepos.length === 0 && <p className="empty-state">{data.github.connected ? "표시할 저장소가 없습니다." : "먼저 GitHub 저장소 접근을 연결해 주세요."}</p>}{githubLoading && <p className="empty-state" role="status">GitHub 저장소 목록을 불러오고 있습니다.</p>}</div></section>}

      {view === "account" && <div className="account-content">
        <section className="panel github-panel"><div className="panel-heading"><h2>GitHub 계정</h2><span className="connected-status"><Icon name="check" size={15} />로그인됨</span></div><div className="github-profile"><span className="avatar large">{initial}</span><div><strong>{displayName}</strong><p>@{user.githubLogin}</p></div><span className="secondary-text">GitHub 인증 완료</span></div></section>
        <section className="panel billing-panel"><div className="panel-heading"><h2>구독 및 AI 사용량</h2><span className="status-pill">{data.billing.subscriptionStatus === "active" ? "구독 활성" : data.billing.subscriptionStatus ? "구독 상태 확인 필요" : "구독 없음"}</span></div><div className="billing-grid"><div><span>구독 가격</span><strong>{data.billing.price === null ? "등록 없음" : `${data.billing.price} ${data.billing.currency}`}</strong></div><div><span>이번 달 AI 사용 기록</span><strong>{data.billing.aiRequests}<small>회</small></strong></div><div><span>AI 예상 비용</span><strong>{data.billing.estimatedAiCost === null ? "산정 기록 없음" : `${data.billing.estimatedAiCost} ${data.billing.currency}`}</strong></div></div><p className="billing-note">구독과 사용량은 DB에 기록된 값만 표시합니다.</p></section>
        <section className="panel table-panel"><div className="panel-heading"><h2>스캔 기록</h2>{repositoryFilter()}</div><div className="table-scroll"><table><thead><tr><th>실행 시각</th><th>저장소</th><th>커밋</th><th>실행 방식</th><th>SAST</th><th>의존성</th><th>상태</th></tr></thead><tbody>{filteredScans.map(scan => <tr key={scan.id}><td>{scan.startedAt}</td><td>{repoName(scan.repositoryId)}{!repositories.find(repo => repo.id === scan.repositoryId)?.connected && <span className="recorded-repo-label">기록만 보관</span>}</td><td><code>{scan.commitSha}</code></td><td>{scan.trigger === "push" ? "커밋" : scan.trigger === "schedule" ? "정기" : "수동"}</td><td>{scan.status === "completed" ? scan.sastCount : "—"}</td><td>{scan.status === "completed" ? scan.cveCount : "—"}</td><td><span className={`scan-status ${scan.status}`}>{scanStatusLabel[scan.status]}</span></td></tr>)}</tbody></table>{filteredScans.length === 0 && <p className="empty-state">이 저장소의 스캔 기록이 없습니다.</p>}</div></section>
        <div className="logout-section"><button className="button secondary" onClick={logout} disabled={loggingOut}><Icon name="logout" size={17} />{loggingOut ? "로그아웃 중…" : "로그아웃"}</button>{logoutError && <p className="logout-error" role="alert">로그아웃하지 못했습니다. 다시 시도해 주세요.</p>}</div>
      </div>}
    </main>

    {selected && <dialog ref={dialogRef} className="detail-modal" aria-labelledby="detail-title" onCancel={() => setSelected(null)}><button type="button" className="modal-close icon-button" aria-label="취약점 상세 닫기" onClick={() => { dialogRef.current?.close(); setSelected(null); }}><Icon name="close" /></button><span className={`severity severity-${selected.severity}`}>{severityLabel[selected.severity]}</span><VulnerabilityDetail vulnerability={selected} repositoryName={repoName(selected.repositoryId)} /></dialog>}
  </div>;
}
