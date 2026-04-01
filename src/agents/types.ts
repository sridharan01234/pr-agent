export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  linesAdded: number;
  linesRemoved: number;
  patch: string;
  isTypeScript: boolean;
  isReact: boolean;
  isTest: boolean;
  isConstants: boolean;
  isListener: boolean;
  isService: boolean;
  isView: boolean;
}

export interface Commit {
  hash: string;
  message: string;
  author: string;
}

export interface PRMetadata {
  number: number;
  title: string;
  description: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  owner: string;
  repository: string;
  installationId: number;
  headSha: string;
}

export interface PRContext {
  pr: PRMetadata;
  changedFiles: ChangedFile[];
  fullDiff: string;
  commits: Commit[];
}

export interface ReviewFinding {
  agentId: string;
  rule: string;
  severity: Severity;
  filePath: string;
  line?: number;
  endLine?: number;
  title: string;
  body: string;
  suggestion?: string;
}

export interface FindingReport {
  agentId: string;
  agentName: string;
  findings: ReviewFinding[];
  skipped: boolean;
  skipReason?: string;
  error?: string;
}

export interface AggregatedReview {
  prContext: PRContext;
  findings: ReviewFinding[];
  summary: string;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  totalCount: number;
  agentsRun: string[];
  agentsSkipped: string[];
  agentErrors: string[];
}

export interface ReviewAgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  shouldRun: (files: ChangedFile[]) => boolean;
}
