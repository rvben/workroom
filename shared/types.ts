export const SOURCES = ["jira", "gitlab", "servicenow", "outlook"] as const;
export type Source = (typeof SOURCES)[number];
export type Mode = "demo" | "live";
export type Kind = "ticket" | "mr" | "incident" | "email";
export interface WorkItem {
  id: string;
  source: Source;
  key: string;
  title: string;
  description: string;
  kind: Kind;
  status: string;
  priority: string;
  assignee: string;
  updatedAt: string;
  observedAt: string;
  url: string;
  reason: string;
  score: number;
  closed: boolean;
  raw: Record<string, any>;
  snoozedUntil?: string;
  note?: string;
}
export interface Link {
  id: string;
  from: string;
  to: string;
  evidence: string;
  state: "explicit" | "suggested" | "confirmed" | "dismissed";
}
export interface Activity {
  id: number;
  itemId: string;
  at: string;
  title: string;
  detail: string;
  actor: string;
}
export interface ConnectorState {
  source: Source;
  enabled: boolean;
  lastSuccess: string | null;
  lastAttempt: string | null;
  error: string | null;
  count: number;
  limited: boolean;
  syncing: boolean;
}
export interface ConnectorConfig {
  enabled: boolean;
  executable: string;
  profile: string;
  query: string;
  baseUrl: string;
  repositories: string[];
  folder: string;
}
export interface Settings {
  mode: Mode;
  refreshMinutes: number;
  connectors: Record<Source, ConnectorConfig>;
  development?: DevelopmentSettings;
}
export interface Proposal {
  id: string;
  itemId: string;
  action: "comment" | "transition" | "note";
  body: string;
  expectedUpdatedAt: string;
  actor: string;
  state:
    "pending" | "executing" | "succeeded" | "failed" | "uncertain" | "rejected";
  createdAt: string;
  result: string;
}
export interface Snapshot {
  items: WorkItem[];
  links: Link[];
  connectors: ConnectorState[];
  proposals: Proposal[];
  mode: Mode;
  syncing: boolean;
  sessions?: WorkSession[];
  teamMembers?: string[];
}
export interface Detail {
  item: WorkItem;
  links: Link[];
  related: WorkItem[];
  activity: Activity[];
  comments: { id: string; author: string; body: string; created: string }[];
  transitions: { id: string; name: string }[];
  detailError?: string;
  sessions?: WorkSession[];
}

export interface LocalRepository {
  id: string;
  name: string;
  path: string;
  project: string;
  baseBranch: string;
}
export interface DevelopmentSettings {
  repositories: LocalRepository[];
  teamMembers: string[];
}
export type SessionState =
  | "preparing"
  | "ready"
  | "working"
  | "blocked"
  | "review"
  | "completed"
  | "failed";
export interface WorkSession {
  id: string;
  itemId: string;
  issueKey: string;
  title: string;
  repository: LocalRepository;
  branch: string;
  baseSha: string;
  worktree: string;
  owner: "human" | "agent";
  state: SessionState;
  objective: string;
  acceptance: string;
  summary: string;
  nextAction: string;
  blocker: string;
  tests: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  handoffs: { at: string; from: string; to: string; summary: string }[];
  steps: {
    name: string;
    state: "pending" | "done" | "failed";
    detail: string;
  }[];
  context: {
    id: string;
    key: string;
    title: string;
    source: Source;
    url: string;
    description: string;
  }[];
  publication?: {
    state:
      | "prepared"
      | "pushing"
      | "creating"
      | "published"
      | "failed"
      | "uncertain";
    sha: string;
    title: string;
    description: string;
    url: string;
    error: string;
    remote: string;
  };
}
export interface StartPlan {
  itemId: string;
  repositoryId: string;
  branch: string;
  owner: "human" | "agent";
  objective: string;
  acceptance: string;
  baseSha: string;
  existingSession?: string;
  repository: LocalRepository;
  warnings: string[];
}
export interface MrSignals {
  mine: boolean;
  reviewRequested: boolean;
  team: boolean;
  identityKnown: boolean;
  author: string;
  reviewers: string[];
  repository: string;
  pipeline: string;
  draft: boolean;
  approved: number | null;
  approvalsLeft: number | null;
  discussions: number | null;
  conflicts: boolean;
  reason: string;
  score: number;
  headSha: string;
  changedSinceReview: boolean;
}
