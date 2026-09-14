import { useId, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import {
  buildJiraQuery,
  parseJiraQuery,
  describeJiraScope,
  DEFAULT_JIRA_SCOPE,
  type JiraProjects,
  type JiraScope,
} from "../shared/jira-scope";
export function JiraScopePicker({
  value,
  disabled,
  onChange,
  loadProjects,
}: {
  value: string;
  disabled: boolean;
  onChange: (query: string) => void;
  loadProjects: () => Promise<JiraProjects>;
}) {
  const id = useId();
  const parsed = parseJiraQuery(value);
  const [advanced, setAdvanced] = useState(!parsed);
  const [manualProject, setManualProject] = useState(false);
  const [result, setResult] = useState<JiraProjects>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [replacement, setReplacement] = useState(false);
  const scope = parsed || DEFAULT_JIRA_SCOPE;
  const update = (change: Partial<JiraScope>) =>
    onChange(buildJiraQuery({ ...scope, ...change }));
  return (
    <fieldset className="setup-jira-scope" disabled={disabled}>
      <legend>Which tickets should appear?</legend>
      {!advanced ? (
        <>
          <label>
            Project
            <select
              value={scope.project}
              onChange={(e) => update({ project: e.target.value })}
            >
              <option value="">All accessible projects</option>
              {scope.project &&
                !result?.projects.some((p) => p.key === scope.project) && (
                  <option value={scope.project}>{scope.project}</option>
                )}
              {result?.projects.map((p) => (
                <option value={p.key} key={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </label>
          <div className="setup-scope-actions">
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setError("");
                try {
                  setResult(await loadProjects());
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setLoading(false);
                }
              }}
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
              {loading
                ? "Loading projects…"
                : result
                  ? "Reload projects"
                  : "Load my projects"}
            </button>
            <button
              type="button"
              className="button"
              aria-expanded={manualProject}
              onClick={() => setManualProject(!manualProject)}
            >
              Enter a project key
            </button>
          </div>
          {manualProject && (
            <label>
              Project key (optional)
              <input
                value={scope.project}
                placeholder="For example, TEAM"
                onChange={(e) => update({ project: e.target.value })}
              />
              <small>
                Use the prefix of a ticket, such as TEAM in TEAM-123. Leave
                empty for all projects.
              </small>
            </label>
          )}
          {!result && (
            <p className="setup-muted">
              Load projects from the selected profile. Sign in below if needed.
            </p>
          )}
          {error && (
            <p role="alert">
              Could not load projects. {error} You can still enter a project
              key.
            </p>
          )}
          {result && (
            <p role="status" className="setup-muted">
              {result.limited
                ? "Showing the first 500 projects. Enter a project key if yours is missing."
                : result.projects.length
                  ? `${result.projects.length} ${result.projects.length === 1 ? "project available" : "projects available"}.`
                  : "No projects were returned for this profile. Check your account access or enter a project key."}
            </p>
          )}
          <div className="setup-scope-fields">
            <label>
              Whose work?
              <select
                value={scope.owner}
                onChange={(e) =>
                  update({ owner: e.target.value as JiraScope["owner"] })
                }
              >
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
                <option value="anyone">Everyone, including unassigned</option>
              </select>
            </label>
            <label>
              Status
              <select
                value={scope.status}
                onChange={(e) =>
                  update({ status: e.target.value as JiraScope["status"] })
                }
              >
                <option value="open">Open work</option>
                <option value="done">Completed work</option>
                <option value="any">Any status</option>
              </select>
            </label>
          </div>
          <p className="setup-scope-summary" role="status">
            {describeJiraScope(scope, result?.projects)}
          </p>
          <button
            type="button"
            className="button"
            aria-expanded={false}
            onClick={() => setAdvanced(true)}
          >
            Advanced: edit JQL <ChevronDown size={14} />
          </button>
        </>
      ) : (
        <>
          <p className="setup-muted">
            Use a custom Jira query for filters such as sprints, labels or
            teams. Your saved query stays intact until you edit or replace it.
          </p>
          <label htmlFor={id}>Custom query (JQL)</label>
          <textarea
            id={id}
            rows={4}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {!value.trim() && (
            <p className="setup-muted">
              An empty query uses your open, assigned work.
            </p>
          )}
          {parsed ? (
            <button
              type="button"
              className="button"
              onClick={() => setAdvanced(false)}
            >
              Use guided filters
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button"
                onClick={() => setReplacement(true)}
              >
                Switch to guided filters
              </button>
              {replacement && (
                <div className="setup-scope-replace">
                  <p>
                    This custom query cannot be represented by the three guided
                    filters. Replace it with your open, assigned work across all
                    projects?
                  </p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      onChange(buildJiraQuery(DEFAULT_JIRA_SCOPE));
                      setAdvanced(false);
                      setReplacement(false);
                    }}
                  >
                    Replace custom query
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setReplacement(false)}
                  >
                    Keep custom query
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </fieldset>
  );
}
