"use client";

import { useState } from "react";
import { defaultScanPolicy } from "@/lib/mock-data";
import type { Repository, Scan, ScanPolicy } from "@/lib/types";

const weekdays = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"];

function scheduleLabel(policy: ScanPolicy) {
  if (!policy.scheduledEnabled) return "사용 안 함";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.time)) return "시각을 입력해 주세요";
  return `${policy.frequency === "daily" ? "매일" : `매주 ${weekdays[policy.weekday - 1]}`} ${policy.time} · 한국 시간`;
}

export default function AnalysisSettings({ repositories, scans, policies, onSave, onOpenRepositories }: {
  repositories: Repository[];
  scans: Scan[];
  policies: Record<string, ScanPolicy>;
  onSave: (repositoryId: string, policy: ScanPolicy) => void;
  onOpenRepositories: () => void;
}) {
  const [selectedId, setSelectedId] = useState(repositories[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, ScanPolicy>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const selected = repositories.find(repo => repo.id === selectedId);
  const draft = drafts[selectedId] ?? policies[selectedId] ?? defaultScanPolicy;
  const latestScan = scans.filter(scan => scan.repositoryId === selectedId).at(-1);
  const isDirty = selected ? JSON.stringify(draft) !== JSON.stringify(policies[selectedId] ?? defaultScanPolicy) : false;
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time);

  function selectRepository(id: string) {
    setSelectedId(id);
    setSavedId(null);
  }

  function change<K extends keyof ScanPolicy>(key: K, value: ScanPolicy[K]) {
    setDrafts(current => ({ ...current, [selectedId]: { ...(current[selectedId] ?? policies[selectedId] ?? defaultScanPolicy), [key]: value } }));
    setSavedId(null);
  }

  function save() {
    if (!selected) return;
    onSave(selected.id, { ...draft });
    setDrafts(current => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    setSavedId(selected.id);
  }

  if (repositories.length === 0) return <section className="panel settings-empty">
    <h2>연결된 저장소가 없습니다</h2>
    <p>분석 설정은 연결된 저장소에서 사용할 수 있습니다.</p>
    <button type="button" className="button primary" onClick={onOpenRepositories}>저장소 연결하기</button>
  </section>;

  return <div className="analysis-layout">
    <section className="panel analysis-repositories" aria-labelledby="analysis-repositories-title">
      <div className="panel-heading"><div><h2 id="analysis-repositories-title">연결된 저장소</h2><p>설정을 변경할 저장소를 선택하세요.</p></div></div>
      {repositories.map(repo => {
        const policy = policies[repo.id] ?? defaultScanPolicy;
        return <button type="button" key={repo.id} className={`analysis-repo ${selectedId === repo.id ? "active" : ""}`} aria-current={selectedId === repo.id ? "true" : undefined} onClick={() => selectRepository(repo.id)}>
          <strong>{repo.name}</strong>
          <span>커밋 {policy.scanOnPush ? "켜짐" : "꺼짐"} · 정기 {policy.scheduledEnabled ? "켜짐" : "꺼짐"}{drafts[repo.id] && JSON.stringify(drafts[repo.id]) !== JSON.stringify(policy) ? " · 저장 전 변경" : ""}</span>
        </button>;
      })}
    </section>

    <div className="analysis-main">
      <section className="panel analysis-form" aria-labelledby="analysis-form-title">
        <div className="panel-heading"><div><h2 id="analysis-form-title">{selected?.name} 분석 설정</h2><p>커밋 검사와 정기 분석을 각각 설정할 수 있습니다.</p></div></div>
        <div className="analysis-section">
          <label className="analysis-toggle"><span><strong>커밋 시 분석</strong><small>새 커밋이 들어오면 기본 브랜치의 변경 사항을 검사합니다.</small></span><input type="checkbox" checked={draft.scanOnPush} onChange={event => change("scanOnPush", event.target.checked)} /></label>
        </div>
        <div className="analysis-section">
          <label className="analysis-toggle"><span><strong>정기 분석</strong><small>커밋이 없어도 설정한 시각에 기본 브랜치를 다시 검사합니다.</small></span><input type="checkbox" checked={draft.scheduledEnabled} onChange={event => change("scheduledEnabled", event.target.checked)} /></label>
          <div className="schedule-fields">
            <label><span>주기</span><select value={draft.frequency} disabled={!draft.scheduledEnabled} onChange={event => change("frequency", event.target.value as ScanPolicy["frequency"])}><option value="daily">매일</option><option value="weekly">매주</option></select></label>
            <label><span>요일</span><select value={draft.weekday} disabled={!draft.scheduledEnabled || draft.frequency !== "weekly"} onChange={event => change("weekday", Number(event.target.value))}>{weekdays.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label>
            <label><span>시각</span><input type="time" value={draft.time} disabled={!draft.scheduledEnabled} onInput={event => change("time", event.currentTarget.value)} /></label>
            <div className="schedule-timezone"><span>시간대</span><strong>한국 시간 (Asia/Seoul)</strong></div>
          </div>
          <p className="schedule-preview">설정된 실행 일정 <strong>{scheduleLabel(draft)}</strong></p>
        </div>
        <div className="analysis-actions"><span role="status">{draft.scheduledEnabled && !validTime ? "정기 분석 시각을 입력해 주세요." : savedId === selectedId ? "이 화면의 예시 설정을 저장했습니다." : isDirty ? "변경 사항을 저장해 주세요." : ""}</span><button type="button" className="button primary" disabled={!isDirty || (draft.scheduledEnabled && !validTime)} onClick={save}>설정 저장</button></div>
      </section>
      <section className="panel analysis-status" aria-label="분석 상태 요약">
        <div><span>마지막 검사</span><strong>{latestScan?.startedAt ?? "기록 없음"}</strong></div>
        <div><span>정기 분석</span><strong>{scheduleLabel(policies[selectedId] ?? defaultScanPolicy)}</strong></div>
      </section>
      <p className="analysis-mock-note">프론트엔드 목업입니다. 설정 저장은 현재 화면에만 반영되며 실제 예약이나 검사는 실행되지 않습니다.</p>
    </div>
  </div>;
}
