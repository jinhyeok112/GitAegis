export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "new" | "open" | "triaging" | "resolved" | "false_positive" | "accepted_risk";

export interface Repository {
  id: string;
  githubId: string;
  name: string;
  url: string;
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
  status: "queued" | "running" | "completed" | "failed" | "canceled";
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

export interface GitHubRepository {
  githubId: string;
  name: string;
  url: string;
  visibility: "public" | "private";
  defaultBranch: string;
}

export interface ActivityDay {
  date: string;
  scans: number;
  findings: number;
}

export interface DashboardData {
  repositories: Repository[];
  vulnerabilities: Vulnerability[];
  scans: Scan[];
  scanPolicies: Record<string, ScanPolicy>;
  activity: ActivityDay[];
  github: { connected: boolean; privateAccess: boolean };
  billing: {
    subscriptionStatus: string | null;
    plan: string | null;
    price: string | null;
    currency: string;
    aiRequests: number;
    estimatedAiCost: string | null;
  };
}
