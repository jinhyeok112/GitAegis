export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "new" | "open" | "triaging" | "resolved" | "false_positive";

export interface Repository {
  id: string;
  name: string;
  visibility: "public" | "private";
  connected: boolean;
  lastScanAt: string | null;
}

export interface Vulnerability {
  id: string;
  repositoryId: string;
  severity: Severity;
  title: string;
  description: string;
  impact: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  code: string | null;
  status: FindingStatus;
  dependency?: {
    packageName: string;
    ecosystem: string;
    installedVersion: string;
    affectedRange: string;
    fixedVersion: string | null;
    advisoryId: string;
    advisoryUrl: string;
  };
  aiSuggestion?: {
    summary: string;
    changes: string[];
    filePath: string;
    beforeCode: string;
    afterCode: string;
    verification: string;
  };
}

export interface Scan {
  id: string;
  repositoryId: string;
  trigger: "push" | "schedule" | "manual";
  status: "queued" | "running" | "completed" | "failed";
  sastCount: number;
  cveCount: number;
  commitSha: string;
  startedAt: string;
}

export interface ScanPolicy {
  scanOnPush: boolean;
  scheduledEnabled: boolean;
  frequency: "daily" | "weekly";
  weekday: number;
  time: string;
  timezone: "Asia/Seoul";
}
