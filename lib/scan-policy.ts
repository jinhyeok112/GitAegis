import type { ScanPolicy } from "@/lib/types";

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
