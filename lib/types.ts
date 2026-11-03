export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "new" | "open" | "triaging" | "resolved" | "false_positive" | "accepted_risk";

export interface AiModelSelection { provider: "openrouter" | "gemini"; model: string }
export interface AiModelOption extends AiModelSelection { label: string; available: boolean }

export interface UpgradeAssessment {
  modelSelection?: AiModelSelection;
  status: "verified" | "unverified" | "no_candidate";
  recommendedVersion: string | null;
  checkedAt: string;
  checkedVersions: number;
  knownAdvisoryIds: string[];
  skippedVersions: { version: string; advisoryIds: string[] }[];
  publishedFixedVersions: string[];
  aiCandidateVersion: string | null;
  aiReason: string | null;
  nvdStatus: "available" | "unavailable" | "no_cve";
  sources: string[];
  explanation: string;
  majorUpdate: boolean;
}

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
  severityScore?: number | null;
  title: string;
  description: string;
  descriptionSource?: "rule" | "semgrep";
  impact: string;
  isTestFixture?: boolean;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  code: string | null;
  codeContext?: string | null;
  contextStartLine?: number | null;
  contextEndLine?: number | null;
  status: FindingStatus;
  dependency?: {
    packageName: string;
    ecosystem: string;
    installedVersion: string;
    affectedRange: string;
    fixedVersion: string | null;
    advisoryId: string;
    advisoryUrl: string;
    assessment?: UpgradeAssessment;
  };
  aiSuggestion?: {
    evidenceKey?: string;
    modelSelection?: AiModelSelection;
    summary: string;
    changes: string[];
    filePath: string;
    beforeCode: string;
    startLine?: number;
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
  scope: "unknown" | "sast" | "sast_dependency";
  errorMessage: string | null;
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
  aiSelection: AiModelSelection;
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
