import { activity } from "@/lib/mock-data";

export default function ActivityChart({ repositoryId }: { repositoryId: string }) {
  const days = activity.map(day => {
    const records = day.repositories.filter(repo => repositoryId === "all" || repo.id === repositoryId);
    return {
      date: day.date,
      scans: records.reduce((sum, repo) => sum + repo.scans, 0),
      findings: records.reduce((sum, repo) => sum + repo.findings, 0),
    };
  });
  const totalScans = days.reduce((sum, day) => sum + day.scans, 0);
  const totalFindings = days.reduce((sum, day) => sum + day.findings, 0);
  const max = Math.max(3, Math.ceil(Math.max(...days.flatMap(day => [day.scans, day.findings])) / 3) * 3);
  const x = (index: number) => 52 + index * 100;
  const y = (value: number) => 214 - (value / max) * 176;
  const points = days.map((day, index) => `${x(index)},${y(day.scans)}`).join(" ");

  return <section className="panel activity-panel" aria-labelledby="activity-title">
    <div className="panel-heading"><h2 id="activity-title">검사 활동</h2><span className="secondary-text">최근 7일</span></div>
    <div className="activity-summary"><span>완료된 검사 <strong>{totalScans}<small>회</small></strong></span><span>탐지된 취약점 <strong>{totalFindings}<small>건</small></strong></span></div>
    <div className="chart-legend"><span><i className="line-key" />완료된 검사</span><span><i className="bar-key" />취약점 탐지 건수</span></div>
    <svg className="activity-chart" viewBox="0 0 704 253" role="img" aria-label={`최근 7일 완료된 검사 ${totalScans}회, 취약점 탐지 ${totalFindings}건. 막대는 취약점 탐지 건수, 선은 완료된 검사 수입니다.`}>
      {[0, max / 3, max * 2 / 3, max].map(value => <g key={value}><line x1="34" x2="680" y1={y(value)} y2={y(value)} stroke="#e1e4e8" /><text x="23" y={y(value) + 4} textAnchor="end" className="chart-axis">{Math.round(value)}</text></g>)}
      {days.map((day, index) => <g key={day.date}><rect x={x(index) - 20} y={y(day.findings)} width="40" height={214 - y(day.findings)} rx="3" fill="#8b919a"><title>{`${day.date}: 취약점 ${day.findings}건, 완료된 검사 ${day.scans}회`}</title></rect><text x={x(index)} y={y(day.findings) - 9} textAnchor="middle" className="bar-value">{day.findings}</text><text x={x(index)} y="242" textAnchor="middle" className="chart-axis">{day.date}</text></g>)}
      <polyline points={points} fill="none" stroke="#191919" strokeWidth="3" strokeLinejoin="round" />
      {days.map((day, index) => <circle key={day.date} cx={x(index)} cy={y(day.scans)} r="4" stroke="#191919" strokeWidth="2" fill="white"><title>{`${day.date}: 완료된 검사 ${day.scans}회`}</title></circle>)}
    </svg>
    <p className="chart-note">탐지 건수는 검사마다 발견한 결과의 합계이며, 같은 취약점이 반복 집계될 수 있습니다.</p>
  </section>;
}
