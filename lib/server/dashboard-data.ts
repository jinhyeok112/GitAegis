import "server-only";
import type { RowDataPacket } from "mysql2";
import type { ActivityDay, DashboardData, ScanPolicy } from "@/lib/types";
import { getDatabase } from "@/lib/server/db";

function dateLabel(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(date);
}

function activityDays(rows: RowDataPacket[]): ActivityDay[] {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - 6 + index);
    const key = day.toISOString().slice(0, 10);
    const row = rows.find(item => item.day === key);
    return { date: `${day.getUTCMonth() + 1}/${day.getUTCDate()}`, scans: Number(row?.scan_count ?? 0), findings: Number(row?.finding_count ?? 0) };
  });
}

export async function loadDashboard(userId: string | null): Promise<DashboardData> {
  if (!userId) return {
    repositories: [], vulnerabilities: [], scans: [], scanPolicies: {}, activity: [],
    github: { connected: false, privateAccess: false },
    billing: { subscriptionStatus: null, plan: null, price: null, currency: "KRW", aiRequests: 0, estimatedAiCost: null },
  };
  const db = getDatabase();
  const [[repositoryRows], [findingRows], [scanRows], [accountRows], [subscriptionRows], [usageRows], [activityRows]] = await Promise.all([
    db.execute<RowDataPacket[]>("SELECT r.*, (SELECT MAX(s.started_at) FROM scans s WHERE s.repository_id = r.id) AS last_scan_at FROM repositories r WHERE r.user_id = ? ORDER BY r.connected DESC, r.full_name", [userId]),
    db.execute<RowDataPacket[]>(`SELECT v.*, f.file_path, f.start_line, f.end_line, f.code_snippet, f.dependency_name, f.dependency_ecosystem, f.installed_version, f.affected_version_range, f.fixed_version, f.advisory_url
      FROM vulnerabilities v JOIN repositories r ON r.id = v.repository_id
      LEFT JOIN scan_findings f ON f.id = (SELECT f2.id FROM scan_findings f2 WHERE f2.vulnerability_id = v.id ORDER BY f2.created_at DESC, f2.id DESC LIMIT 1)
      WHERE r.user_id = ? ORDER BY v.last_seen_at DESC`, [userId]),
    db.execute<RowDataPacket[]>("SELECT s.* FROM scans s JOIN repositories r ON r.id = s.repository_id WHERE r.user_id = ? ORDER BY COALESCE(s.started_at, s.created_at) DESC LIMIT 200", [userId]),
    db.execute<RowDataPacket[]>("SELECT scope FROM github_accounts WHERE user_id = ?", [userId]),
    db.execute<RowDataPacket[]>("SELECT plan_code, status, base_price, currency FROM subscriptions WHERE user_id = ?", [userId]),
    db.execute<RowDataPacket[]>("SELECT COUNT(*) AS requests, CASE WHEN COUNT(*) = COUNT(estimated_cost) THEN SUM(estimated_cost) ELSE NULL END AS estimated_cost FROM ai_usage_records WHERE user_id = ? AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01 00:00:00')", [userId]),
    db.execute<RowDataPacket[]>(`SELECT DATE_FORMAT(DATE_ADD(COALESCE(s.started_at, s.created_at), INTERVAL 9 HOUR), '%Y-%m-%d') AS day, COUNT(*) AS scan_count, SUM(s.sast_count + s.dependency_count) AS finding_count
      FROM scans s JOIN repositories r ON r.id = s.repository_id
      WHERE r.user_id = ? AND s.status = 'completed' AND COALESCE(s.started_at, s.created_at) >= UTC_TIMESTAMP() - INTERVAL 7 DAY GROUP BY day`, [userId]),
  ]);
  const scanPolicies: Record<string, ScanPolicy> = {};
  for (const row of repositoryRows) scanPolicies[String(row.id)] = {
    scanOnPush: Boolean(row.scan_on_push), scheduledEnabled: Boolean(row.scheduled_scan_enabled),
    frequency: row.scheduled_scan_frequency, weekday: Number(row.scheduled_scan_weekday),
    time: String(row.scheduled_scan_time).slice(0, 5), timezone: "Asia/Seoul",
  };
  const subscription = subscriptionRows[0];
  return {
    repositories: repositoryRows.map(row => ({ id: String(row.id), githubId: String(row.github_repository_id), name: String(row.full_name), url: `https://github.com/${row.full_name}`, visibility: row.visibility, connected: Boolean(row.connected), lastScanAt: dateLabel(row.last_scan_at) })),
    vulnerabilities: findingRows.map(row => ({
      id: String(row.id), repositoryId: String(row.repository_id), severity: row.severity, title: row.title,
      description: row.description ?? "설명 정보가 없습니다.", impact: row.impact ?? "영향 정보가 없습니다.",
      filePath: row.file_path ?? null, startLine: row.start_line ?? null, endLine: row.end_line ?? null,
      code: row.code_snippet ?? null, status: row.status,
      ...(row.dependency_name ? { dependency: { packageName: row.dependency_name, ecosystem: row.dependency_ecosystem ?? "", installedVersion: row.installed_version ?? "미확인", affectedRange: row.affected_version_range ?? "미확인", fixedVersion: row.fixed_version ?? null, advisoryId: row.external_id ?? "", advisoryUrl: /^https?:\/\//.test(row.advisory_url ?? "") ? row.advisory_url : "" } } : {}),
    })),
    scans: scanRows.map(row => ({ id: String(row.id), repositoryId: String(row.repository_id), trigger: row.trigger_type, status: row.status, sastCount: Number(row.sast_count), cveCount: Number(row.dependency_count), commitSha: row.commit_sha ? String(row.commit_sha).slice(0, 7) : "—", startedAt: dateLabel(row.started_at ?? row.created_at) ?? "시각 없음" })),
    scanPolicies, activity: activityDays(activityRows),
    github: { connected: accountRows.length > 0, privateAccess: String(accountRows[0]?.scope ?? "").split(/[ ,]+/).includes("repo") },
    billing: { subscriptionStatus: subscription?.status ?? null, plan: subscription?.plan_code ?? null, price: subscription?.base_price == null ? null : String(subscription.base_price), currency: subscription?.currency ?? "KRW", aiRequests: Number(usageRows[0]?.requests ?? 0), estimatedAiCost: usageRows[0]?.estimated_cost == null ? null : String(usageRows[0].estimated_cost) },
  };
}
