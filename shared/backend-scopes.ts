import { projectParts } from "./mrs.js";
export type IncidentScope = {
  owner: "mine-and-groups" | "me" | "groups" | "unassigned" | "anyone";
  status: "active" | "inactive" | "any";
  priority: "any" | "critical" | "high";
};
export const DEFAULT_INCIDENT_SCOPE: IncidentScope = {
  owner: "mine-and-groups",
  status: "active",
  priority: "any",
};
const incidentOwners = {
  "mine-and-groups":
    "assigned_to=javascript:gs.getUserID()^ORassignment_group=javascript:getMyGroups()",
  me: "assigned_to=javascript:gs.getUserID()",
  groups: "assignment_group=javascript:getMyGroups()",
  unassigned: "assigned_toISEMPTY",
  anyone: "",
};
export function buildIncidentQuery(scope: IncidentScope) {
  return [
    scope.status === "any" ? "" : `active=${scope.status === "active"}`,
    incidentOwners[scope.owner],
    scope.priority === "critical"
      ? "priority=1"
      : scope.priority === "high"
        ? "priorityIN1,2"
        : "",
    "ORDERBYDESCsys_updated_on",
  ]
    .filter(Boolean)
    .join("^");
}
export function parseIncidentQuery(query: string): IncidentScope | null {
  if (!query.trim()) return { ...DEFAULT_INCIDENT_SCOPE };
  for (const owner of Object.keys(incidentOwners) as IncidentScope["owner"][])
    for (const status of ["active", "inactive", "any"] as const)
      for (const priority of ["any", "critical", "high"] as const) {
        const scope = { owner, status, priority };
        if (buildIncidentQuery(scope) === query.trim()) return scope;
      }
  return null;
}
export function describeIncidentScope(scope: IncidentScope) {
  const status = { active: "Active", inactive: "Inactive", any: "All" }[
    scope.status
  ];
  const owner = {
    "mine-and-groups": "assigned to you or one of your groups",
    me: "assigned to you",
    groups: "assigned to your groups",
    unassigned: "without an assignee",
    anyone: "across your accessible queues",
  }[scope.owner];
  const priority = {
    any: "",
    critical: " with critical priority (1)",
    high: " with critical or high priority (1–2)",
  }[scope.priority];
  return `${status} incidents ${owner}${priority}, most recently updated first.`;
}
export function normalizeGitLabHost(value: string) {
  value = value.trim();
  const url = new URL(
    value.includes("://") ? value.trim() : `https://${value.trim()}`,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    !url.hostname ||
    (!url.hostname.startsWith("[") &&
      !url.hostname
        .split(".")
        .every((part) =>
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(part),
        )) ||
    /\s/.test(value)
  )
    throw new Error(
      "Enter your GitLab site URL, without a project path or credentials.",
    );
  return url.host;
}
export function initialGitLabUrl(baseUrl: string, projects: string[]) {
  if (baseUrl) return baseUrl;
  try {
    return `https://${projects[0] ? projectParts(projects[0]).host : "gitlab.com"}`;
  } catch {
    return "https://gitlab.com";
  }
}
export function canonicalGitLabProject(host: string, path: string) {
  host = normalizeGitLabHost(host);
  const parts = path
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (
    parts.length < 2 ||
    parts.some(
      (p) =>
        !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p) || p === "." || p === "..",
    )
  )
    throw new Error("Use a project URL or group/project path.");
  return `${host.includes(".") || host.includes(":") || host === "localhost" ? "" : "https://"}${host}/${parts.join("/")}`;
}
export function addGitLabProject(input: string, currentHost: string) {
  const value = input.trim();
  let host = currentHost,
    path = value;
  if (/^https?:\/\//.test(value)) ({ host, path } = projectParts(value));
  else if (value.startsWith(currentHost + "/"))
    path = value.slice(currentHost.length + 1);
  else if (/^[^/]*[.:][^/]*\//.test(value))
    ({ host, path } = projectParts(value));
  return {
    host: normalizeGitLabHost(host),
    project: canonicalGitLabProject(host, path),
  };
}
export function sameGitLabProject(a: string, b: string) {
  try {
    const left = projectParts(a),
      right = projectParts(b);
    return (
      canonicalGitLabProject(left.host, left.path) ===
      canonicalGitLabProject(right.host, right.path)
    );
  } catch {
    return a === b;
  }
}
export interface GitLabProjectPage {
  host: string;
  projects: { project: string; name: string; path: string }[];
  page: number;
  more: boolean;
}
export interface MailFolderPage {
  folders: { id: string; name: string; children: number }[];
  cursor: string;
  limited: boolean;
}
export const MAIL_FOLDERS = [
  { id: "inbox", name: "Inbox" },
  { id: "sentitems", name: "Sent mail" },
  { id: "drafts", name: "Drafts" },
  { id: "deleteditems", name: "Deleted mail" },
  { id: "junkemail", name: "Junk mail" },
];
export function simpleMailSearch(query: string) {
  return !/[:"()\\]|\b(?:AND|OR|NOT)\b/.test(query);
}
