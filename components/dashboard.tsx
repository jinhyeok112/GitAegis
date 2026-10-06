"use client";

import { useEffect, useRef, useState } from "react";
import ActivityChart from "@/components/activity-chart";
import AnalysisSettings from "@/components/analysis-settings";
import DatabaseDesignView from "@/components/database-design";
import type { DatabaseDesign } from "@/lib/database-design";
import VulnerabilityDetail from "@/components/vulnerability-detail";
import { repositories as initialRepositories, initialScanPolicies, scans, vulnerabilities, mockUser } from "@/lib/mock-data";
import type { ScanPolicy, Vulnerability } from "@/lib/types";

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
const statusLabel = { new: "새로 발견", open: "미해결", triaging: "검토 중", resolved: "해결", false_positive: "오탐" };
const scanStatusLabel = { queued: "대기", running: "검사 중", completed: "완료", failed: "실패" };

export default function Dashboard({ databaseDesign }: { databaseDesign: DatabaseDesign }) {
  const [view, setView] = useState<View>("overview");
  const [repositories, setRepositories] = useState(initialRepositories);
  const [scanPolicies, setScanPolicies] = useState<Record<string, ScanPolicy>>(initialScanPolicies);
  const [search, setSearch] = useState("");
  const [findingKind, setFindingKind] = useState("all");
  const [repositoryId, setRepositoryId] = useState("all");
  const [selected, setSelected] = useState<Vulnerability | null>(null);
  const [loggedIn, setLoggedIn] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [selected]);
  const recordedRepositoryIds = new Set([...scans.map(scan => scan.repositoryId), ...vulnerabilities.map(item => item.repositoryId)]);
  const connectedRepositories = repositories.filter(repo => repo.connected);
  const historyRepositories = repositories.filter(repo => !repo.connected && recordedRepositoryIds.has(repo.id));
  const selectableRepositories = [...connectedRepositories, ...historyRepositories];
  const filteredRepos = repositories.filter(repo => repo.name.toLowerCase().includes(search.toLowerCase()));
  const filteredVulnerabilities = vulnerabilities.filter(item => selectableRepositories.some(repo => repo.id === item.repositoryId) && (repositoryId === "all" || item.repositoryId === repositoryId) && (findingKind === "all" || (findingKind === "dependency" ? Boolean(item.dependency) : !item.dependency)));
  const needsReview = vulnerabilities.filter(item => item.status !== "resolved" && item.status !== "false_positive");
  const codeFindings = needsReview.filter(item => !item.dependency);
  const packageFindings = needsReview.filter(item => item.dependency);
  const activeScans = scans.filter(scan => scan.status === "queued" || scan.status === "running");
  const filteredScans = scans.filter(scan => selectableRepositories.some(repo => repo.id === scan.repositoryId) && (repositoryId === "all" || scan.repositoryId === repositoryId)).sort((a, b) => Number(!repositories.find(repo => repo.id === a.repositoryId)?.connected) - Number(!repositories.find(repo => repo.id === b.repositoryId)?.connected));

  function navigate(next: View) { setView(next); setSearch(""); if (next === "vulnerabilities") setFindingKind("all"); }
  function openFindings(kind: string) { setView("vulnerabilities"); setFindingKind(kind); setRepositoryId("all"); }
  function repoName(id: string) { return repositories.find(repo => repo.id === id)?.name ?? "저장소"; }
  function toggleRepository(id: string) {
    setRepositories(current => current.map(repo => repo.id === id ? { ...repo, connected: !repo.connected } : repo));
    if (repositoryId === id && !recordedRepositoryIds.has(id)) setRepositoryId("all");
  }
  function logout() { setSelected(null); setLoggedIn(false); setView("overview"); setRepositoryId("all"); setFindingKind("all"); setSearch(""); setRepositories(initialRepositories); setScanPolicies(initialScanPolicies); }

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
      {filteredVulnerabilities.length === 0 && repositoryId === "all" && <p className="empty-state">발견된 취약점이 없습니다.</p>}
    </section>;
  }

  if (!loggedIn) return <main className="login-screen"><section className="login-card"><div className="brand"><span className="brand-symbol"><Icon name="shield" size={23} /></span>GitAegis</div><h1>GitHub 계정으로 시작하기</h1><p>저장소를 연결하고 보안 취약점을 확인하세요.</p><button className="button primary" onClick={() => setLoggedIn(true)}>GitHub로 계속하기</button><small>프론트엔드 목업 · 예시 계정으로 로그인합니다.</small></section></main>;

  return <div className="workspace">
    <aside className="sidebar"><button className="brand" onClick={() => navigate("overview")} aria-label="GitAegis 대시보드"><span className="brand-symbol"><Icon name="shield" size={22} /></span>GitAegis</button><nav aria-label="주요 메뉴">{menu.map(item => <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav><div className="sidebar-bottom"><button className="profile" onClick={() => navigate("account")}><span className="avatar">{mockUser.initial}</span><span><strong>{mockUser.name}</strong><small>@{mockUser.githubLogin}</small></span><Icon name="chevron" size={16} /></button></div></aside>

    <main className="main-content"><header className="page-header"><div><h1>{view === "overview" ? "보안 대시보드" : view === "repositories" ? "Git 저장소 가져오기" : menu.find(item => item.id === view)?.label}</h1><p>{view === "overview" ? "발견된 보안 문제와 검사 추이를 확인하세요." : view === "repositories" ? "검사할 GitHub 저장소를 선택하세요." : view === "analysis" ? "저장소별 커밋 검사와 정기 분석 일정을 설정하세요." : view === "account" ? "GitHub 연결, AI 사용량과 스캔 기록을 관리하세요." : view === "database" ? "교수님 검토용 · 테이블 관계와 데이터 구조를 확인하세요." : "저장소별로 발견된 취약점을 확인하세요."}</p></div><span className="demo-label">예시 데이터</span></header>

      {view === "overview" && <>
        <section className="dashboard-summary" aria-label="확인할 항목">
          <article className="panel action-card"><h2>검토할 코드</h2><div className="action-value">{codeFindings.length}<span>건</span></div><p>코드 위치와 위험 설명을 확인하세요.</p><button className="action-link" onClick={() => openFindings("code")}>코드 취약점 확인 <Icon name="chevron" size={15} /></button></article>
          <article className="panel action-card"><h2>업데이트할 패키지</h2><div className="action-value">{packageFindings.length}<span>개</span></div><p>{packageFindings[0]?.dependency ? `${packageFindings[0].dependency.packageName} ${packageFindings[0].dependency.installedVersion} · 수정 버전 ${packageFindings[0].dependency.fixedVersion ?? "미공개"}` : "업데이트가 필요한 패키지가 없습니다."}</p><button className="action-link" onClick={() => openFindings("dependency")}>업그레이드 안내 <Icon name="chevron" size={15} /></button></article>
          <article className="panel action-card"><h2>진행 중인 검사</h2><div className="action-value">{activeScans.length}<span>건</span></div><p>{activeScans[0] ? repoName(activeScans[0].repositoryId) : "진행 중인 검사가 없습니다."}</p><button className="action-link" onClick={() => navigate("account")}>검사 상태 확인 <Icon name="chevron" size={15} /></button></article>
        </section>
        <div className="dashboard-grid">
          <section className="panel dashboard-findings"><div className="panel-heading"><h2>최근 취약점</h2><button className="action-link" onClick={() => openFindings("all")}>전체 보기 <Icon name="chevron" size={15} /></button></div>
            {vulnerabilities.slice(0, 5).map(item => <button key={item.id} className="recent-finding" onClick={() => setSelected(item)}><span className={`severity severity-${item.severity}`}>{severityLabel[item.severity]}</span><span className="recent-finding-main"><strong>{item.dependency ? `${item.dependency.packageName} · ${item.dependency.advisoryId}` : item.title}</strong><span><Icon name="repo" size={13} />{repoName(item.repositoryId)}</span></span><Icon name="chevron" size={16} /></button>)}
            <div className="recent-footer">취약점을 선택하면 코드 위치 또는 수정 버전을 확인할 수 있습니다.</div>
          </section>
          <ActivityChart repositoryId="all" />
        </div>
      </>}
      {view === "vulnerabilities" && <><div className="filter-toolbar">{repositoryFilter()}<label className="repository-filter"><span>종류</span><select aria-label="취약점 종류" value={findingKind} onChange={event => setFindingKind(event.target.value)}><option value="all">취약점 전체</option><option value="code">코드 취약점</option><option value="dependency">의존성 취약점</option></select></label></div>{findingsPanel()}</>}

      {view === "analysis" && <AnalysisSettings repositories={connectedRepositories} scans={scans} policies={scanPolicies} onSave={(id, policy) => setScanPolicies(current => ({ ...current, [id]: policy }))} onOpenRepositories={() => navigate("repositories")} />}
      {view === "database" && <DatabaseDesignView design={databaseDesign} />}

      {view === "repositories" && <section><div className="repository-toolbar"><div className="account-select"><Icon name="repo" /><span>@{mockUser.githubLogin}</span><span className="connection-text">GitHub 연결됨</span></div><label className="search-field"><Icon name="search" /><input aria-label="저장소 검색" placeholder="저장소 검색" value={search} onChange={event => setSearch(event.target.value)} /></label></div><div className="panel import-list">{filteredRepos.map(repo => <div className="import-row" key={repo.id}><span className="repo-avatar">{repo.name[0].toUpperCase()}</span><span className="import-name"><strong>{repo.name}</strong><span><Icon name="lock" size={13} />{repo.visibility === "private" ? "비공개" : "공개"} · {repo.connected ? "연결됨" : recordedRepositoryIds.has(repo.id) ? "연결 해제 · 기록 보관" : "연결 가능"}</span></span><button className={`button ${repo.connected ? "secondary" : "primary"}`} onClick={() => toggleRepository(repo.id)}>{repo.connected ? "연결 해제" : "가져오기"}</button></div>)}{filteredRepos.length === 0 && <p className="empty-state">검색 결과가 없습니다.</p>}</div></section>}

      {view === "account" && <div className="account-content">
        <section className="panel github-panel"><div className="panel-heading"><h2>GitHub 계정</h2><span className="connected-status"><Icon name="check" size={15} />연결됨</span></div><div className="github-profile"><span className="avatar large">{mockUser.initial}</span><div><strong>{mockUser.name}</strong><p>@{mockUser.githubLogin}</p></div><span className="secondary-text">예시 계정</span></div></section>
        <section className="panel billing-panel"><div className="panel-heading"><h2>구독 및 AI 사용량</h2><span className="status-pill">유료 계정</span></div><div className="billing-grid"><div><span>구독 가격</span><strong>추후 안내</strong></div><div><span>이번 기간 AI 분석</span><strong>64<small>회</small></strong></div><div><span>AI 추가 비용</span><strong>요율 미정</strong></div></div><p className="billing-note">AI 설명과 수정 제안은 사용량에 따라 추가 과금할 예정입니다.</p></section>
        <section className="panel table-panel"><div className="panel-heading"><h2>스캔 기록</h2>{repositoryFilter()}</div><div className="table-scroll"><table><thead><tr><th>실행 시각</th><th>저장소</th><th>커밋</th><th>실행 방식</th><th>SAST</th><th>의존성</th><th>상태</th></tr></thead><tbody>{filteredScans.map(scan => <tr key={scan.id}><td>{scan.startedAt}</td><td>{repoName(scan.repositoryId)}{!repositories.find(repo => repo.id === scan.repositoryId)?.connected && <span className="recorded-repo-label">기록만 보관</span>}</td><td><code>{scan.commitSha}</code></td><td>{scan.trigger === "push" ? "커밋" : scan.trigger === "schedule" ? "정기" : "수동"}</td><td>{scan.status === "completed" ? scan.sastCount : "—"}</td><td>{scan.status === "completed" ? scan.cveCount : "—"}</td><td><span className={`scan-status ${scan.status}`}>{scanStatusLabel[scan.status]}</span></td></tr>)}</tbody></table>{filteredScans.length === 0 && <p className="empty-state">이 저장소의 스캔 기록이 없습니다.</p>}</div></section>
        <div className="logout-section"><button className="button secondary" onClick={logout}><Icon name="logout" size={17} />로그아웃</button></div>
      </div>}
    </main>

    {selected && <dialog ref={dialogRef} className="detail-modal" aria-labelledby="detail-title" onCancel={() => setSelected(null)}><button type="button" className="modal-close icon-button" aria-label="취약점 상세 닫기" onClick={() => { dialogRef.current?.close(); setSelected(null); }}><Icon name="close" /></button><span className={`severity severity-${selected.severity}`}>{severityLabel[selected.severity]}</span><VulnerabilityDetail vulnerability={selected} repositoryName={repoName(selected.repositoryId)} /></dialog>}
  </div>;
}
