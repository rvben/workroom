import { useState } from "react";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import {
  buildIncidentQuery,
  parseIncidentQuery,
  describeIncidentScope,
  DEFAULT_INCIDENT_SCOPE,
  normalizeGitLabHost,
  addGitLabProject,
  sameGitLabProject,
  MAIL_FOLDERS,
  simpleMailSearch,
  type IncidentScope,
  type GitLabProjectPage,
  type MailFolderPage,
} from "../shared/backend-scopes";

function CustomQuery({
  value,
  onChange,
  onGuided,
  canGuide,
  defaultDescription,
  label,
  disabled,
}: {
  value: string;
  onChange: (s: string) => void;
  onGuided: () => void;
  canGuide: boolean;
  defaultDescription: string;
  label: string;
  disabled: boolean;
}) {
  const [replace, setReplace] = useState(false);
  return (
    <>
      <label>
        {label}
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      </label>
      <p className="setup-muted">
        Your custom settings stay intact until you edit or replace them.
      </p>
      <button
        className="button"
        type="button"
        onClick={() => (canGuide ? onGuided() : setReplace(true))}
      >
        Use guided choices
      </button>
      {replace && (
        <div className="setup-scope-replace">
          <p>
            This query uses custom filters. Replace it with {defaultDescription}
            ?
          </p>
          <button className="button" type="button" onClick={onGuided}>
            Replace custom query
          </button>
          <button
            className="button"
            type="button"
            onClick={() => setReplace(false)}
          >
            Keep custom query
          </button>
        </div>
      )}
    </>
  );
}
export function IncidentScopePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (s: string) => void;
  disabled: boolean;
}) {
  const parsed = parseIncidentQuery(value);
  const [advanced, setAdvanced] = useState(!parsed);
  const scope = parsed || DEFAULT_INCIDENT_SCOPE;
  const update = (next: Partial<IncidentScope>) =>
    onChange(buildIncidentQuery({ ...scope, ...next }));
  return (
    <fieldset className="setup-jira-scope" disabled={disabled}>
      <legend>Which incidents should appear?</legend>
      {advanced ? (
        <CustomQuery
          value={value}
          onChange={onChange}
          disabled={disabled}
          label="Custom incident query"
          canGuide={!!parsed}
          defaultDescription="active incidents assigned to you or your groups"
          onGuided={() => {
            if (!parsed) onChange(buildIncidentQuery(DEFAULT_INCIDENT_SCOPE));
            setAdvanced(false);
          }}
        />
      ) : (
        <>
          <label>
            Whose incidents?
            <select
              value={scope.owner}
              onChange={(e) =>
                update({ owner: e.target.value as IncidentScope["owner"] })
              }
            >
              <option value="mine-and-groups">Mine and my groups</option>
              <option value="me">Assigned to me</option>
              <option value="groups">Assigned to my groups</option>
              <option value="unassigned">Unassigned</option>
              <option value="anyone">Everyone I can access</option>
            </select>
          </label>
          <div className="setup-scope-fields">
            <label>
              Status
              <select
                value={scope.status}
                onChange={(e) =>
                  update({ status: e.target.value as IncidentScope["status"] })
                }
              >
                <option value="active">Active incidents</option>
                <option value="inactive">Inactive incidents</option>
                <option value="any">Any status</option>
              </select>
            </label>
            <label>
              Priority
              <select
                value={scope.priority}
                onChange={(e) =>
                  update({
                    priority: e.target.value as IncidentScope["priority"],
                  })
                }
              >
                <option value="any">Any priority</option>
                <option value="critical">Critical (1)</option>
                <option value="high">Critical or high (1–2)</option>
              </select>
            </label>
          </div>
          <p className="setup-scope-summary" role="status">
            {describeIncidentScope(scope)}
          </p>
          <p className="setup-muted">
            Your signed-in ServiceNow account determines “me” and “my groups”.
            Active status follows your instance’s rules.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => setAdvanced(true)}
          >
            Advanced: edit incident query
          </button>
        </>
      )}
    </fieldset>
  );
}
export function GitLabProjectPicker({
  url,
  projects,
  disabled,
  onUrl,
  onProjects,
  load,
}: {
  url: string;
  projects: string[];
  disabled: boolean;
  onUrl: (s: string) => void;
  onProjects: (s: string[]) => void;
  load: (
    host: string,
    search: string,
    page: number,
  ) => Promise<GitLabProjectPage>;
}) {
  const [search, setSearch] = useState(""),
    [result, setResult] = useState<GitLabProjectPage>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [manual, setManual] = useState(false),
    [entry, setEntry] = useState("");
  const request = async (page = 1) => {
    setLoading(true);
    setError("");
    try {
      const next = await load(normalizeGitLabHost(url), search, page);
      setResult((old) =>
        page > 1 && old?.host === next.host
          ? {
              ...next,
              projects: [...old.projects, ...next.projects].filter(
                (p, i, all) =>
                  all.findIndex((x) => x.project === p.project) === i,
              ),
            }
          : next,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const toggle = (project: string) => {
    if (projects.some((p) => sameGitLabProject(p, project)))
      onProjects(projects.filter((p) => !sameGitLabProject(p, project)));
    else if (projects.length < 20) onProjects([...projects, project]);
  };
  return (
    <fieldset className="setup-jira-scope" disabled={disabled}>
      <legend>Where does your team work?</legend>
      <label>
        GitLab site URL
        <input
          type="url"
          value={url}
          placeholder="https://gitlab.example.com"
          onChange={(e) => {
            onUrl(e.target.value);
            setResult(undefined);
            setError("");
          }}
        />
        <small>
          Use GitLab.com or your organisation’s GitLab site. Sign in to this
          host below.
        </small>
      </label>
      <label>
        Find a project (optional)
        <input
          type="search"
          value={search}
          placeholder="Project or group name"
          onChange={(e) => {
            setSearch(e.target.value);
            setResult(undefined);
          }}
        />
      </label>
      <div className="setup-scope-actions">
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => void request()}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          {loading ? "Loading projects…" : "Find my projects"}
        </button>
        <button
          type="button"
          className="button"
          aria-expanded={manual}
          onClick={() => setManual(!manual)}
        >
          Paste a project URL
        </button>
      </div>
      {manual && (
        <div className="setup-project-entry">
          <label>
            Project URL or group/project
            <input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="https://gitlab.example.com/team/project"
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={!entry.trim() || projects.length >= 20}
            onClick={() => {
              try {
                const next = addGitLabProject(entry, normalizeGitLabHost(url));
                if (!projects.some((p) => sameGitLabProject(p, next.project)))
                  onProjects([...projects, next.project]);
                if (next.host !== normalizeGitLabHost(url)) {
                  onUrl(`https://${next.host}`);
                  setResult(undefined);
                }
                setEntry("");
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Add project
          </button>
        </div>
      )}
      {error && <p role="alert">Could not load or add projects. {error}</p>}
      {result && (
        <div className="setup-discovery">
          <p className="setup-muted" role="status">
            {result.projects.length
              ? `${result.projects.length} ${result.projects.length === 1 ? "project" : "projects"} found in your memberships.`
              : "No matching projects in your memberships. Try another name or paste a project URL."}
          </p>
          <div className="setup-discovery-list">
            {result.projects.map((p) => (
              <label className="setup-project-option" key={p.project}>
                <input
                  type="checkbox"
                  checked={projects.some((value) =>
                    sameGitLabProject(value, p.project),
                  )}
                  disabled={
                    !projects.some((value) =>
                      sameGitLabProject(value, p.project),
                    ) && projects.length >= 20
                  }
                  onChange={() => toggle(p.project)}
                />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.path}</small>
                </span>
              </label>
            ))}
          </div>
          {result.more && (
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={() => void request(result.page + 1)}
            >
              Load more projects
            </button>
          )}
        </div>
      )}
      <div className="setup-selected-projects">
        <strong>{projects.length} of 20 projects selected</strong>
        {projects.map((p) => (
          <div className="setup-selected-row" key={p}>
            <span>
              {result?.projects.find((r) => sameGitLabProject(r.project, p))
                ?.name || p}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${p}`}
              onClick={() => onProjects(projects.filter((x) => x !== p))}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      <p className="setup-scope-summary">
        Workroom collects open MRs from these projects and separates your MRs,
        requests for your review, and team activity.
      </p>
      <p className="setup-muted">
        Team activity includes all authors in the selected projects unless you
        narrow the team in local repository settings. Add projects from another
        host by changing the site URL; existing selections stay selected.
      </p>
    </fieldset>
  );
}
export function OutlookScopePicker({
  folder,
  query,
  disabled,
  onFolder,
  onQuery,
  load,
}: {
  folder: string;
  query: string;
  disabled: boolean;
  onFolder: (s: string) => void;
  onQuery: (s: string) => void;
  load: (parent?: string, cursor?: string) => Promise<MailFolderPage>;
}) {
  const [browse, setBrowse] = useState(false),
    [result, setResult] = useState<MailFolderPage>(),
    [trail, setTrail] = useState<{ id: string; name: string }[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [advanced, setAdvanced] = useState(!simpleMailSearch(query)),
    [names, setNames] = useState<Record<string, string>>({});
  const label =
    MAIL_FOLDERS.find((f) => f.id === folder)?.name ||
    names[folder] ||
    "Saved custom folder";
  const request = async (nextTrail = trail, cursor?: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await load(nextTrail.at(-1)?.id, cursor);
      setTrail(nextTrail);
      setResult((old) =>
        cursor && old
          ? {
              ...next,
              folders: [...old.folders, ...next.folders].filter(
                (f, i, a) => a.findIndex((x) => x.id === f.id) === i,
              ),
            }
          : next,
      );
      setNames((old) => ({
        ...old,
        ...Object.fromEntries(next.folders.map((f) => [f.id, f.name])),
      }));
      setBrowse(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <fieldset className="setup-jira-scope" disabled={disabled}>
      <legend>Which email should appear?</legend>
      <label>
        Mail folder
        <select
          value={folder || "inbox"}
          onChange={(e) => onFolder(e.target.value)}
        >
          {MAIL_FOLDERS.map((f) => (
            <option value={f.id} key={f.id}>
              {f.name}
            </option>
          ))}
          {folder && !MAIL_FOLDERS.some((f) => f.id === folder) && (
            <option value={folder}>{label}</option>
          )}
        </select>
      </label>
      <button
        type="button"
        className="button"
        disabled={loading}
        onClick={() => void request([])}
      >
        <RefreshCw size={14} className={loading ? "spin" : ""} />
        {loading ? "Loading folders…" : "Browse my folders"}
      </button>
      {error && (
        <p role="alert">
          Could not load folders. {error} Sign in with the selected profile and
          try again.
        </p>
      )}
      {browse && result && (
        <div className="setup-discovery">
          <nav className="setup-folder-trail" aria-label="Mail folder location">
            <button
              type="button"
              className="button"
              onClick={() => void request([])}
            >
              Mailbox
            </button>
            {trail.map((f, i) => (
              <button
                type="button"
                className="button"
                key={f.id}
                onClick={() => void request(trail.slice(0, i + 1))}
              >
                {f.name}
              </button>
            ))}
          </nav>
          <div className="setup-discovery-list">
            {result.folders.map((f) => (
              <div key={f.id} className="setup-folder-row">
                <button
                  type="button"
                  className="button"
                  aria-pressed={folder === f.id}
                  onClick={() => {
                    onFolder(f.id);
                    setBrowse(false);
                  }}
                >
                  {f.name}
                </button>
                {f.children > 0 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Open subfolders of ${f.name}`}
                    onClick={() =>
                      void request([...trail, { id: f.id, name: f.name }])
                    }
                  >
                    <ChevronRight size={17} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {!result.folders.length && (
            <p role="status">No folders on this page.</p>
          )}
          {result.cursor && (
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={() => void request(trail, result.cursor)}
            >
              Load more folders
            </button>
          )}
          {result.limited && (
            <p className="setup-muted">
              Folder discovery is incomplete. Continue loading or retry to see
              more.
            </p>
          )}
          <button
            type="button"
            className="button"
            onClick={() => setBrowse(false)}
          >
            Close folder browser
          </button>
        </div>
      )}
      {advanced ? (
        <>
          <CustomQuery
            value={query}
            onChange={onQuery}
            disabled={disabled}
            label="Custom email search"
            canGuide={simpleMailSearch(query)}
            defaultDescription="recent mail in the selected folder"
            onGuided={() => {
              if (!simpleMailSearch(query)) onQuery("");
              setAdvanced(false);
            }}
          />
          <label>
            Custom folder ID
            <input value={folder} onChange={(e) => onFolder(e.target.value)} />
          </label>
          <p className="setup-muted">
            Microsoft 365 supports Outlook search syntax. Outlook Desktop uses
            literal subject and sender text.
          </p>
        </>
      ) : (
        <>
          <label className="setup-mail-topic">
            Topic or ticket key (optional)
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="For example, service outage or TEAM-123"
            />
            <small>Leave empty to collect recent mail in this folder.</small>
          </label>
          <p className="setup-scope-summary" role="status">
            {query
              ? `Messages matching “${query}” in ${label}.`
              : `Recent messages in ${label}.`}{" "}
            Related tickets and incidents are linked where matching references
            are found.
          </p>
          <p className="setup-muted">
            Search checks sender and subject; Microsoft 365 also searches
            message text. The inbox is collected per message, so a matching
            thread may be incomplete.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => setAdvanced(true)}
          >
            Advanced: search and folder settings
          </button>
        </>
      )}
    </fieldset>
  );
}
