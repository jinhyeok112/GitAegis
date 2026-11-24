import type { ScanPolicy } from "@/lib/types";

export const COMMIT_CHECK_INTERVAL_SECONDS = 60;

export const defaultScanPolicy: ScanPolicy = {
  scanOnPush: false,
  scheduledEnabled: false,
  frequency: "weekly",
  weekday: 1,
  time: "09:00",
  timezone: "Asia/Seoul",
};

export function isScanPolicy(value: unknown): value is ScanPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  return typeof policy.scanOnPush === "boolean" && typeof policy.scheduledEnabled === "boolean" &&
    (policy.frequency === "daily" || policy.frequency === "weekly") &&
    Number.isInteger(policy.weekday) && Number(policy.weekday) >= 1 && Number(policy.weekday) <= 7 &&
    typeof policy.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(policy.time) &&
    policy.timezone === "Asia/Seoul";
}

export function nextScheduledScan(now: Date, policy: Pick<ScanPolicy, "frequency" | "weekday" | "time">) {
  // The UI supports Asia/Seoul only, which is UTC+09:00 year-round.
  const offset = 9 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  const [hours, minutes] = policy.time.split(":").map(Number);
  local.setUTCHours(hours, minutes, 0, 0);
  if (policy.frequency === "weekly") {
    const days = (policy.weekday % 7 - local.getUTCDay() + 7) % 7;
    local.setUTCDate(local.getUTCDate() + days);
  }
  if (local.getTime() - offset <= now.getTime()) {
    local.setUTCDate(local.getUTCDate() + (policy.frequency === "weekly" ? 7 : 1));
  }
  return new Date(local.getTime() - offset);
}
