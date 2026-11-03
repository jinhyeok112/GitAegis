"use client";

import { useEffect, useState } from "react";
import type { AiModelOption, AiModelSelection } from "@/lib/types";
import { aiSelectionKey, aiSelectionLabel } from "@/lib/ai-models";

interface Settings { selection: AiModelSelection; models: AiModelOption[]; warning: string | null }

export default function AiModelSettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/ai/settings", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "AI 모델 설정을 불러오지 못했습니다.");
        if (!controller.signal.aborted) { setSettings(data); setDraft(aiSelectionKey(data.selection)); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "AI 모델을 불러오지 못했습니다."); }
    }
    void load();
    return () => controller.abort();
  }, [revision]);
  async function save() {
    const model = settings?.models.find(option => aiSelectionKey(option) === draft);
    if (!model) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/ai/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: model.provider, model: model.model }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI 모델을 저장하지 못했습니다.");
      setSettings(current => current ? { ...current, selection: data.selection } : current);
      setMessage("선택한 모델을 내 계정에 저장했습니다. 다음 수정안 생성부터 적용됩니다.");
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "AI 모델을 저장하지 못했습니다."); }
    finally { setSaving(false); }
  }
  const selected = settings?.models.find(option => aiSelectionKey(option) === draft);
  return <section className="panel ai-model-settings" aria-labelledby="ai-model-settings-title">
    <div className="panel-heading"><div><h2 id="ai-model-settings-title">AI 수정안 모델</h2><p>Semgrep 탐지 결과의 수정안과 의존성 공지의 버전 근거 검토에 사용할 모델입니다.</p></div></div>
    {settings ? <>
      <label htmlFor="ai-model-choice">사용할 모델</label>
      <div className="ai-model-controls"><select id="ai-model-choice" value={draft} disabled={saving} onChange={event => { setDraft(event.target.value); setMessage(""); }}>
        {!settings.models.some(option => aiSelectionKey(option) === aiSelectionKey(settings.selection)) && <option value={aiSelectionKey(settings.selection)} disabled>{aiSelectionLabel(settings.selection)} · 현재 목록에서 확인 불가</option>}
        {(["gemini", "openrouter"] as const).map(provider => <optgroup key={provider} label={provider === "gemini" ? "Gemini · 무료 티어 대상" : "OpenRouter · 무료 모델"}>{settings.models.filter(option => option.provider === provider).map(option => <option key={aiSelectionKey(option)} value={aiSelectionKey(option)} disabled={!option.available}>{option.label}{option.available ? "" : " · 서버 연결 필요"}</option>)}</optgroup>)}
      </select><button type="button" className="button primary" disabled={saving || !selected?.available || draft === aiSelectionKey(settings.selection)} onClick={() => void save()}>{saving ? "저장 중…" : "모델 저장"}</button></div>
      <p className="secondary-text">내 계정의 현재 모델: {aiSelectionLabel(settings.selection)}</p>
      <p className="secondary-text">Gemini는 API 프로젝트의 무료 한도·요금제를 따릅니다. Google AI 구독과 API 사용량은 별개입니다.</p>
      {settings.warning && <p role="status">{settings.warning}</p>}
      <button type="button" className="action-link" disabled={saving} onClick={() => setRevision(value => value + 1)}>모델 목록 다시 확인</button>
    </> : !error && <p role="status">AI 모델 목록을 불러오고 있습니다.</p>}
    {error && <p className="data-error" role="alert">{error}</p>}
    {error && !settings && <button type="button" className="button secondary" onClick={() => setRevision(value => value + 1)}>다시 시도</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
