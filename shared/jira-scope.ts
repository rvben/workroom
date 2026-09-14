export interface JiraScope {
  project: string;
  owner: "me" | "unassigned" | "anyone";
  status: "open" | "done" | "any";
}
export const DEFAULT_JIRA_SCOPE: JiraScope = {
  project: "",
  owner: "me",
  status: "open",
};
export interface JiraProject {
  key: string;
  name: string;
}
export interface JiraProjects {
  projects: JiraProject[];
  limited: boolean;
}
export function buildJiraQuery(scope: JiraScope): string {
  const clauses = [];
  if (scope.project.trim())
    clauses.push(`project = ${JSON.stringify(scope.project.trim())}`);
  if (scope.owner === "me") clauses.push("assignee = currentUser()");
  if (scope.owner === "unassigned") clauses.push("assignee IS EMPTY");
  if (scope.status !== "any")
    clauses.push(`statusCategory ${scope.status === "open" ? "!=" : "="} Done`);
  return `${clauses.length ? clauses.join(" AND ") + " " : ""}ORDER BY updated DESC`;
}
// Deliberately recognize only this builder's small grammar. Everything else stays custom.
export function parseJiraQuery(query: string): JiraScope | null {
  if (!query.trim()) return { ...DEFAULT_JIRA_SCOPE };
  const match = query.trim().match(/^(.*?)\s*ORDER\s+BY\s+updated\s+DESC$/i);
  if (!match) return null;
  const scope: JiraScope = { project: "", owner: "anyone", status: "any" };
  const seen = new Set<string>();
  const clauses = match[1].trim();
  if (!clauses) return scope;
  // Split conjunctions outside quoted project values only.
  const parts: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < clauses.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && clauses[i] === "\\") {
      escaped = true;
      continue;
    }
    if (clauses[i] === '"') quoted = !quoted;
    if (!quoted) {
      const separator = clauses.slice(i).match(/^\s+AND\s+/i);
      if (separator) {
        parts.push(clauses.slice(start, i));
        i += separator[0].length - 1;
        start = i + 1;
      }
    }
  }
  if (quoted) return null;
  parts.push(clauses.slice(start));
  for (const clause of parts) {
    const project = clause.match(
      /^project\s*=\s*("(?:[^"\\]|\\.)*"|[A-Za-z][A-Za-z0-9_-]*)$/i,
    );
    let field: string;
    if (project) {
      field = "project";
      try {
        scope.project = project[1].startsWith('"')
          ? JSON.parse(project[1])
          : project[1];
      } catch {
        return null;
      }
      if (!scope.project.trim()) return null;
    } else if (/^assignee\s*=\s*currentUser\(\)$/i.test(clause)) {
      field = "owner";
      scope.owner = "me";
    } else if (/^assignee\s+IS\s+EMPTY$/i.test(clause)) {
      field = "owner";
      scope.owner = "unassigned";
    } else if (/^statusCategory\s*!=\s*Done$/i.test(clause)) {
      field = "status";
      scope.status = "open";
    } else if (/^statusCategory\s*=\s*Done$/i.test(clause)) {
      field = "status";
      scope.status = "done";
    } else return null;
    if (seen.has(field)) return null;
    seen.add(field);
  }
  return scope;
}
export function describeJiraScope(
  scope: JiraScope,
  projects: JiraProject[] = [],
): string {
  const status = {
    open: "Open tickets",
    done: "Completed tickets",
    any: "Tickets of any status",
  }[scope.status];
  const owner = {
    me: "assigned to you",
    unassigned: "without an assignee",
    anyone: "for everyone, including unassigned work",
  }[scope.owner];
  const project =
    projects.find((p) => p.key === scope.project)?.name || scope.project;
  return `${status} ${owner} ${project ? `in ${project}` : "across your accessible projects"}, most recently updated first.`;
}
