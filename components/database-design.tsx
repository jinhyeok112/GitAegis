"use client";

import { useState } from "react";
import type { DatabaseDesign } from "@/lib/database-design";

const tableInfo: Record<string, { label: string; purpose: string }> = {
  users: { label: "사용자", purpose: "GitHub 식별자로 사용자를 구분하고 계정 정보를 보관합니다." },
  subscriptions: { label: "구독", purpose: "사용자당 하나의 현재 구독과 결제 서비스 식별자를 관리합니다." },
  invoices: { label: "청구서", purpose: "구독료와 AI 사용 요금을 청구 기간별로 기록합니다. 금액은 요율 확정 전 NULL입니다." },
  repositories: { label: "저장소 · 분석 설정", purpose: "사용자가 연결한 저장소와 커밋·정기 검사 정책을 관리합니다. 연결 해제 시 기록을 유지합니다." },
  vulnerabilities: { label: "취약점", purpose: "저장소별 문제를 fingerprint로 식별해 여러 검사에서도 동일 취약점의 상태를 유지합니다." },
  scans: { label: "검사 실행", purpose: "커밋·정기·수동 검사마다 실행 상태, 검사 대상 커밋과 결과 건수를 기록합니다." },
  scan_findings: { label: "검사별 발견 내역", purpose: "검사와 취약점을 연결하고 해당 실행의 파일·코드·패키지 버전 정보를 보관합니다." },
  ai_usage_records: { label: "AI 사용량", purpose: "사용자별 AI 기능 사용과 토큰 수를 기록합니다. 저장소·취약점 연결은 선택 사항입니다." },
  vulnerability_events: { label: "취약점 상태 이력", purpose: "문제의 상태 변경, 변경한 사용자와 사유를 시간순으로 보관합니다. 자동 변경은 사용자 없이 기록할 수 있습니다." },
};

const diagramNodes = [
  { name: "users", x: 30, y: 65, category: "시작 · 사용자 계정" },
  { name: "repositories", x: 340, y: 65, category: "메인 · 저장소 연결" },
  { name: "scans", x: 650, y: 65, category: "메인 · 검사 실행" },
  { name: "scan_findings", x: 650, y: 375, category: "메인 · 검사 결과" },
  { name: "vulnerabilities", x: 340, y: 375, category: "메인 · 취약점 관리" },
  { name: "ai_usage_records", x: 30, y: 375, category: "서브 · AI 사용량" },
  { name: "vulnerability_events", x: 340, y: 745, category: "서브 · 상태 변경 이력" },
  { name: "subscriptions", x: 30, y: 745, category: "결제 · 구독", billing: true },
  { name: "invoices", x: 30, y: 945, category: "결제 · 청구서", billing: true },
];
// Parent → child routes use the spaces between cards, rather than crossing table contents.
const diagramRoutes: Record<string, { path: string; x: number; y: number; note?: string }> = {
  "repositories.user_id": { path: "M270 170 H340", x: 305, y: 154 },
  "scans.repository_id": { path: "M580 170 H650", x: 615, y: 154 },
  "vulnerabilities.repository_id": { path: "M460 275 V375", x: 493, y: 325 },
  "scan_findings.scan_id": { path: "M770 275 V375", x: 803, y: 325 },
  "scan_findings.vulnerability_id": { path: "M580 480 H650", x: 615, y: 464 },
  "ai_usage_records.user_id": { path: "M150 275 V375", x: 180, y: 325 },
  "ai_usage_records.repository_id": { path: "M340 215 H310 V420 H270", x: 310, y: 356, note: "저장소" },
  "ai_usage_records.vulnerability_id": { path: "M340 530 H270", x: 305, y: 514 },
  "vulnerability_events.vulnerability_id": { path: "M460 585 V745", x: 495, y: 668 },
  "vulnerability_events.actor_user_id": { path: "M30 145 H12 V680 H300 V805 H340", x: 183, y: 669, note: "변경한 사용자 · 선택" },
  "subscriptions.user_id": { path: "M100 275 V310 H285 V805 H270", x: 148, y: 720, note: "사용자 구독" },
  "invoices.subscription_id": { path: "M150 855 V945", x: 185, y: 905 },
};

export default function DatabaseDesignView({ design }: { design: DatabaseDesign }) {
  const [selected, setSelected] = useState("users");
  const [tab, setTab] = useState<"erd" | "sql">("erd");
  const table = design.tables.find(item => item.name === selected)!;
  const related = design.relations.filter(item => item.from === selected || item.to === selected);

  function entity(name: string, compact = false) {
    const item = design.tables.find(item => item.name === name)!;
    const info = tableInfo[name];
    const connected = related.some(relation => relation.from === name || relation.to === name);
    return <button className={`db-flow-entity ${compact ? "compact" : ""} ${selected === name ? "selected" : connected ? "related" : ""}`} onClick={() => setSelected(name)} aria-pressed={selected === name}>
      <span className="db-flow-title"><strong>{info.label}</strong><code>{name}</code></span>
      <span className="db-flow-keys">{item.columns.filter(column => column.primary || column.foreign || (name === "users" && ["github_user_id", "github_login"].includes(column.name))).map(column => <span key={column.name}><b>{column.primary ? "PK" : column.foreign ? "FK" : ""}</b><code>{column.name}</code></span>)}</span>
      <small>{item.columns.length}개 컬럼 · 상세 보기</small>
    </button>;
  }

  function downloadSql() {
    const url = URL.createObjectURL(new Blob([design.sql], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "gitaegis-schema.sql";
    link.click();
    URL.revokeObjectURL(url);
  }

  return <div className="db-design">
    <section className="db-review-banner"><div><strong>DB 설계 검토 화면</strong><p>MySQL 8 설계 초안 · 실제 DB 연결 없이 구조를 확인하는 임시 화면입니다.</p></div><button className="button secondary" onClick={downloadSql}>SQL 다운로드</button></section>
    <div className="db-toolbar"><div className="db-tabs" role="tablist" aria-label="DB 설계 보기"><button role="tab" id="db-erd-tab" aria-selected={tab === "erd"} aria-controls="db-erd-panel" onClick={() => setTab("erd")}>테이블 관계도</button><button role="tab" id="db-sql-tab" aria-selected={tab === "sql"} aria-controls="db-sql-panel" onClick={() => setTab("sql")}>SQL 원문</button></div><span>{design.tables.length}개 테이블 · {design.relations.length}개 외래키</span></div>
    {tab === "sql" ? <section role="tabpanel" id="db-sql-panel" aria-labelledby="db-sql-tab" className="panel db-sql"><pre>{design.sql}</pre></section> : <div role="tabpanel" id="db-erd-panel" aria-labelledby="db-erd-tab">
      <section className="panel db-diagram-panel">
        <div className="panel-heading"><div><h2>전체 데이터베이스 관계도</h2><p>사용자에서 저장소·검사·취약점으로 이어집니다. 9개 테이블과 12개 외래키를 모두 표시하며, 구독·청구만 작게 배치했습니다.</p></div></div>
        <div className="db-erd-guide"><strong>users → repositories → scans → scan_findings</strong><span>발견 내역은 vulnerabilities를 참조하고, 취약점에서 AI 사용량·상태 이력으로 연결됩니다.</span></div>
        <div className="db-erd-scroll"><div className="db-erd-canvas">
          <svg className="db-erd-lines" viewBox="0 0 940 1110" aria-hidden="true"><defs><marker id="db-parent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="context-stroke" /></marker></defs>
            {design.relations.map(relation => {
              const route = diagramRoutes[`${relation.from}.${relation.column}`];
              const highlighted = relation.from === selected || relation.to === selected;
              const billing = ["subscriptions", "invoices"].includes(relation.from);
              const core = ["repositories", "scans", "vulnerabilities", "scan_findings"].includes(relation.from);
              const color = highlighted ? "#161b23" : billing ? "#8b95a3" : core ? "#384455" : "#68778b";
              return <g key={`${relation.from}-${relation.column}`}><path d={route.path} fill="none" stroke={color} strokeWidth={highlighted ? 2.3 : 1.6} strokeDasharray={relation.optional ? "6 4" : undefined} markerEnd="url(#db-parent-arrow)" /><text x={route.x} y={route.y} textAnchor="middle" className="db-erd-relation-label" fill={color}>{route.note ?? (relation.unique ? "1 : 0..1" : "1 : N")}</text></g>;
            })}
          </svg>
          {diagramNodes.map(node => <div className={`db-erd-node ${node.billing ? "billing" : ""}`} key={node.name} style={{ left: node.x, top: node.y }}><span className="db-erd-category">{node.category}</span>{entity(node.name, Boolean(node.billing))}</div>)}
          <div className="db-erd-note"><strong>검사와 취약점은 N:M</strong><p>scan_findings가 두 테이블을 연결합니다. 같은 취약점이 여러 검사에서 발견되어도 해결 상태는 vulnerabilities에서 관리합니다.</p></div>
        </div></div>
        <details className="db-all-relations"><summary>전체 외래키 관계 확인 · {design.relations.length}개</summary><div className="table-scroll"><table><thead><tr><th>부모 테이블</th><th>관계</th><th>자식 테이블 · FK</th><th>참조 여부</th></tr></thead><tbody>{design.relations.map(item => <tr key={`${item.from}-${item.column}`}><td><button className="action-link" onClick={() => setSelected(item.to)}>{item.to}</button></td><td>{item.unique ? "1 : 0..1" : "1 : 0..N"}</td><td><button className="action-link" onClick={() => setSelected(item.from)}>{item.from}.{item.column}</button></td><td>{item.optional ? "선택" : "필수"}</td></tr>)}</tbody></table></div></details>
        <p className="db-legend">화살표: 부모(PK) → 자식(FK) · 1:N의 자식은 0개 가능 · 실선: 필수 참조 / 점선: 선택 참조 · PK 기본키 / FK 외래키 · 검은 테이블: 선택됨</p>
      </section>
      <section className="panel db-table-detail"><div className="panel-heading"><div><h2>{table.name} <span>{tableInfo[table.name].label}</span></h2><p>{tableInfo[table.name].purpose}</p></div><label className="repository-filter"><span>테이블</span><select aria-label="테이블 선택" value={selected} onChange={event => setSelected(event.target.value)}>{design.tables.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label></div>
        <div className="table-scroll"><table className="db-columns"><thead><tr><th>컬럼</th><th>키</th><th>NULL 허용</th><th>자료형 · 기본값 · 설명</th></tr></thead><tbody>{table.columns.map(column => <tr key={column.name}><td><code>{column.name}</code></td><td>{column.primary ? "PK" : column.foreign ? "FK" : "—"}</td><td>{column.nullable ? "허용" : "불가"}</td><td><code>{column.definition}</code></td></tr>)}</tbody></table></div>
        <div className="db-constraints"><h3>인덱스 · 무결성 제약</h3>{table.constraints.map(item => <code key={item}>{item}</code>)}</div>
      </section>
      <section className="panel db-relations"><div className="panel-heading"><div><h2>선택한 테이블의 관계</h2><p>한 부모 레코드에는 자식이 0개 이상 존재할 수 있습니다. 자식에서 부모를 반드시 참조하는지는 필수 여부로 표시합니다.</p></div></div><div className="table-scroll"><table><thead><tr><th>참조하는 컬럼 (FK)</th><th>참조 대상 (PK)</th><th>부모 : 자식</th><th>자식의 부모 참조</th></tr></thead><tbody>{related.map(item => <tr key={`${item.from}-${item.column}`}><td><button className="action-link" onClick={() => setSelected(item.from)}>{item.from}.{item.column}</button></td><td><button className="action-link" onClick={() => setSelected(item.to)}>{item.to}.{item.target}</button></td><td>{item.unique ? "1 : 0..1" : "1 : 0..N"}</td><td>{item.optional ? "선택 (NULL 허용)" : "필수"}</td></tr>)}</tbody></table></div></section>
      <section className="panel db-notes"><h2>설계 의도 · 검토할 사항</h2><div><article><h3>검사 결과와 문제 상태 분리</h3><p>scans ↔ vulnerabilities는 scan_findings로 연결한 N:M 관계입니다. 검사마다 발견 위치와 버전은 기록하고, 동일 문제의 해결 상태는 유지합니다.</p></article><article><h3>연결 해제 후 이력 보관</h3><p>repositories.connected만 변경합니다. 스캔·취약점은 유지하며 외래키에는 자동 연쇄 삭제를 설정하지 않았습니다.</p></article><article><h3>정기 분석과 사용량 과금</h3><p>정기 검사 정책은 저장소에, 실행 기록은 scans에 저장합니다. AI 토큰과 예상 비용은 ai_usage_records에 기록하고 청구 기간별 합계를 invoices에 보관합니다.</p></article><article><h3>구현 전 확정할 내용</h3><p>AI 해결 설명·수정 전후 코드는 현재 목업 전용입니다. 실제 응답 저장 테이블, 구독 변경 이력, 청구와 사용량 연결, 데이터 보존 정책은 후속 설계 대상입니다. 검사와 취약점이 동일 저장소에 속하는지도 저장 시 검증해야 합니다.</p></article></div></section>
    </div>}
    <section className="panel db-notes db-sources"><h2>CVE · CWE 데이터 출처와 확인 방식</h2><p className="db-source-intro">아래는 실제 분석을 구현할 때의 연동 계획입니다. 현재 화면의 취약점은 더미 데이터이며 외부 API를 호출하지 않습니다. CVE는 공개된 개별 취약점의 ID, CWE는 SQL 삽입·XSS 같은 약점 유형의 ID입니다.</p><div>
      <article><h3>1. CVE 조회 → NVD API</h3><p>CVE 데이터는 NIST의 NVD API 2.0을 이용할 계획입니다. CVE ID로 취약점 설명, CVSS 위험도, 영향받는 제품·버전 조건과 제공된 CWE 분류를 확인합니다. 분류나 점수가 없으면 미제공으로 표시합니다.</p><code>GET https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-23337</code><a href="https://nvd.nist.gov/developers/vulnerabilities" target="_blank" rel="noreferrer">NVD 공식 API 문서 ↗</a></article>
      <article><h3>2. 패키지 · 버전 영향 여부 확인</h3><p>lock 파일에서 패키지 이름·설치 버전을 추출한 뒤 NVD 제품 식별자(CPE)와 매핑하고, CVE의 영향 버전 범위와 대조합니다. 이름 검색만으로 취약하다고 확정하지 않습니다. CPE 매핑이 불확실하거나 데이터가 없으면 확인 필요로 표시합니다.</p><p>최소 수정 버전은 NVD의 참고 링크에 있는 패키지 공식 보안 공지·릴리스 정보를 통해 확인합니다. NVD가 모든 패키지의 수정 버전을 별도 필드로 제공한다고 가정하지 않습니다. 버전 계열별로 확인하며 근거가 없으면 수정 버전 미확인으로 표시합니다.</p><a href="https://nvd.nist.gov/developers/products" target="_blank" rel="noreferrer">NVD CPE API 문서 ↗</a></article>
      <article><h3>3. 코드 취약점 → Semgrep + CWE API</h3><p>코드의 문제 탐지는 Semgrep이 담당합니다. 검사 규칙의 CWE 메타데이터를 읽고, MITRE CWE API로 해당 약점의 이름·설명·대응 정보를 조회합니다. CWE API는 코드의 안전 여부를 검사하는 API가 아닙니다.</p><code>GET https://cwe-api.mitre.org/api/v1/cwe/weakness/79</code><p>CWE API는 등록이나 인증 없이 조회할 수 있습니다. 분류가 없는 규칙은 CWE 미지정으로 표시하고, 설명 데이터는 서버에 캐시해 재사용합니다.</p><a href="https://github.com/CWE-CAPEC/REST-API-wg/blob/main/Quick%20Start.md" target="_blank" rel="noreferrer">MITRE CWE API 안내 ↗</a><a href="https://github.com/semgrep/semgrep-rules/blob/develop/metadata-schema.yaml.schm" target="_blank" rel="noreferrer">Semgrep 규칙 메타데이터 ↗</a></article>
      <article><h3>4. 서버에서 조회하고 결과 보관</h3><p>예정 흐름: 저장소 검사 → 패키지 버전/코드 문제 추출 → NVD·CWE 조회 → 결과 정규화 → DB 저장 → 화면 표시입니다. API 키는 서버에서 관리하고 캐시·재시도·조회 시각을 기록합니다.</p><p>현재 SQL의 external_id와 scan_findings에 advisory 및 버전을 기록할 수 있습니다. CPE 매핑, 복수 CWE 분류와 원본 응답·조회 시각을 저장하는 구조는 실제 연동 전 추가 설계가 필요합니다.</p></article>
    </div></section>
  </div>;
}
