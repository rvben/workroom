import { useState, useEffect } from "react";
import {
  GitBranch,
  GitPullRequest,
  ArrowRight,
  Copy,
  UserRound,
  Bot,
} from "lucide-react";
import { WorkTimeline } from "./timeline";
import { api } from "./api";
import { mrSignals } from "../shared/mrs";
import type {
  Snapshot,
  WorkItem,
  WorkSession,
  StartPlan,
  LocalRepository,
  DevelopmentSettings,
} from "../shared/types";
export function MrWorkspace({
  snapshot,
  open,
  search,
}: {
  snapshot: Snapshot;
  open: (id: string) => void;
  search: string;
}) {
  const [tab, setTab] = useState("My MRs");
  const [repo, setRepo] = useState("All repositories");
  const all = snapshot.items
    .filter((i) => i.source === "gitlab" && !i.closed)
    .map((i) => ({ i, s: mrSignals(i, snapshot.teamMembers) }));
  const belongs = (s: ReturnType<typeof mrSignals>, t: string) =>
    t === "My MRs" ? s.mine : t === "Review queue" ? s.reviewRequested : s.team;
  const rows = all
    .filter(
      ({ i, s }) =>
        belongs(s, tab) &&
        (repo === "All repositories" || s.repository === repo) &&
        `${i.title} ${i.key} ${s.author}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.s.score - a.s.score);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CODE & COLLABORATION</div>
          <h1>Move work toward merge.</h1>
          <p>Your changes, your reviews, and the team’s progress.</p>
        </div>
        <img src="/logos/gitlab.svg" width="36" alt="GitLab" />
      </div>
      <div className="dev-toolbar">
        <div className="dev-tabs">
          {["My MRs", "Review queue", "Team MRs"].map((t) => (
            <button
              key={t}
              aria-pressed={tab === t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}
              <span>{all.filter((x) => belongs(x.s, t)).length}</span>
            </button>
          ))}
        </div>
        <select
          aria-label="Filter repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        >
          {["All repositories", ...new Set(all.map((x) => x.s.repository))].map(
            (r) => (
              <option key={r}>{r}</option>
            ),
          )}
        </select>
      </div>
      {all.some((x) => !x.s.identityKnown) && (
        <div className="alert">
          GitLab identity is unavailable for some repositories. Their MRs appear
          under Team MRs until identity can be refreshed.
        </div>
      )}
      <div className="dev-list">
        {rows.map(({ i, s }) => (
          <button className="mr-card" key={i.id} onClick={() => open(i.id)}>
            <GitPullRequest size={21} />
            <div>
              <div className="row-meta">
                {s.repository}{" "}
                <span>
                  · {i.key} · {s.author}
                </span>
              </div>
              <h3>{i.title}</h3>
              <p className={s.score >= 70 ? "dev-urgent" : ""}>{s.reason}</p>
              <div className="dev-signals">
                <span>{s.draft ? "Draft" : "Open"}</span>
                <span className={s.pipeline === "failed" ? "danger" : ""}>
                  CI {s.pipeline === "unknown" ? "not loaded" : s.pipeline}
                </span>
                <span>
                  {s.approved === null
                    ? "Approvals not loaded"
                    : `${s.approved} approvals`}
                </span>
                {s.conflicts && <span className="danger">Conflicts</span>}
              </div>
            </div>
            <ArrowRight size={17} />
          </button>
        ))}
        {!rows.length && (
          <div className="dev-empty">
            <GitPullRequest />
            <h2>
              {tab === "Review queue"
                ? "No reviews waiting here."
                : "No matching merge requests."}
            </h2>
            <p>
              {tab === "Team MRs"
                ? "Refresh GitLab or adjust the watched repositories in Connections."
                : "This view uses your authenticated GitLab identity."}
            </p>
          </div>
        )}
      </div>
      <p className="settings-footnote">
        Team MRs includes watched repositories, narrowed by team usernames when
        configured. Unknown checks are never treated as passed.
      </p>
    </>
  );
}
export function StartWork({
  item,
  done,
}: {
  item: WorkItem;
  done: () => void;
}) {
  const [repos, setRepos] = useState<LocalRepository[]>([]);
  const [repositoryId, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [owner, setOwner] = useState<"human" | "agent">("human");
  const [objective, setObjective] = useState(item.title);
  const [acceptance, setAcceptance] = useState("");
  const [plan, setPlan] = useState<StartPlan>();
  const [result, setResult] = useState<WorkSession>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ repositories: LocalRepository[]; branch: string }>(
      "/work/options?itemId=" + encodeURIComponent(item.id),
    )
      .then((x) => {
        setRepos(x.repositories);
        setRepo(x.repositories[0]?.id || "");
        setBranch(x.branch);
      })
      .catch((e) => setError(e.message));
  }, [item.id]);
  async function run(start: boolean) {
    setBusy(true);
    setError("");
    try {
      const body = {
        itemId: item.id,
        repositoryId,
        branch,
        owner,
        objective,
        acceptance,
        baseSha: plan?.baseSha,
      };
      if (start) {
        setResult(await api("/work/start", "POST", body));
        done();
      } else setPlan(await api("/work/plan", "POST", body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dev-start">
      <h3>
        <GitBranch size={18} /> Start work
      </h3>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {result ? (
        <>
          <p>
            {result.state === "failed"
              ? "Setup needs attention."
              : "Work session ready."}
          </p>
          <p>{result.steps[1].detail}</p>
          <p>
            Open Work sessions to continue, record progress or hand this work to
            an agent.
          </p>
        </>
      ) : plan ? (
        <>
          <p>
            <strong>{plan.repository.name}</strong> ·{" "}
            {owner === "human"
              ? "You own the next step"
              : "Ready for an agent to claim"}
          </p>
          <code>{plan.branch}</code>
          <p>
            Base: {plan.repository.baseBranch} · {plan.baseSha.slice(0, 12)}
          </p>
          {plan.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <div className="dev-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setPlan(undefined)}
            >
              Edit plan
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void run(true)}
            >
              {busy
                ? "Creating…"
                : plan.existingSession
                  ? "Use existing session"
                  : "Create local work session"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Create an isolated branch and worktree, with the ticket and
            confirmed related context attached.
          </p>
          {!repos.length ? (
            <p>Add an existing local repository in Connections first.</p>
          ) : (
            <>
              <label>
                Repository
                <select
                  value={repositoryId}
                  onChange={(e) => setRepo(e.target.value)}
                >
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Branch
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label>
                Who starts?
                <select
                  value={owner}
                  onChange={(e) => setOwner(e.target.value as typeof owner)}
                >
                  <option value="human">Me</option>
                  <option value="agent">An agent</option>
                </select>
              </label>
              <label>
                Objective
                <textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                />
              </label>
              <label>
                Acceptance criteria
                <textarea
                  placeholder="What must be true before this is done?"
                  value={acceptance}
                  onChange={(e) => setAcceptance(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !objective.trim()}
                onClick={() => void run(false)}
              >
                {busy ? "Checking repository…" : "Review work plan"}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
export function SessionWorkspace({
  snapshot,
  reload,
  open,
}: {
  snapshot: Snapshot;
  reload: () => Promise<void>;
  open: (id: string) => void;
}) {
  const [id, setId] = useState("");
  const sessions = snapshot.sessions || [];
  const selected = sessions.find((s) => s.id === id) || sessions[0];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">HUMAN + AGENT</div>
          <h1>One thread of work.</h1>
          <p>Keep the branch, context and next owner together.</p>
        </div>
      </div>
      {!sessions.length ? (
        <div className="dev-empty">
          <GitBranch />
          <h2>Pick a ticket. Start something.</h2>
          <p>
            Open a Jira ticket and choose Start work to create a branch and a
            shared work session.
          </p>
        </div>
      ) : (
        <div className="session-layout">
          <aside className="session-list" aria-label="Work sessions">
            {sessions.map((s) => (
              <button
                className={selected?.id === s.id ? "active" : ""}
                key={s.id}
                onClick={() => setId(s.id)}
              >
                <small>
                  {s.issueKey} · {s.state}
                </small>
                <strong>{s.title}</strong>
                <span>
                  {s.owner === "human" ? (
                    <UserRound size={14} />
                  ) : (
                    <Bot size={14} />
                  )}{" "}
                  {s.leaseOwner ||
                    (s.owner === "human"
                      ? "Your next move"
                      : "Awaiting agent claim")}
                </span>
              </button>
            ))}
          </aside>
          {selected && (
            <SessionEditor
              key={selected.id + ":" + selected.version}
              s={selected}
              mode={snapshot.mode}
              reload={reload}
              open={open}
            />
          )}
        </div>
      )}
    </>
  );
}
function SessionEditor({
  s,
  mode,
  reload,
  open,
}: {
  s: WorkSession;
  mode: string;
  reload: () => Promise<void>;
  open: (id: string) => void;
}) {
  const [summary, setSummary] = useState(s.summary);
  const [tests, setTests] = useState(s.tests);
  const [next, setNext] = useState(s.nextAction);
  const [blocker, setBlocker] = useState(s.blocker);
  const [state, setState] = useState<string>(
    ["working", "blocked", "review", "completed"].includes(s.state)
      ? s.state
      : "working",
  );
  const [handoff, setHandoff] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [title, setTitle] = useState(
    s.publication?.title || `${s.issueKey}: ${s.title}`,
  );
  const [description, setDescription] = useState(
    s.publication?.description ||
      `${s.objective}\n\nAcceptance criteria\n${s.acceptance}\n\nImplementation\n${s.summary}\n\nValidation\n${s.tests}`,
  );
  const dirty =
    summary !== s.summary ||
    tests !== s.tests ||
    next !== s.nextAction ||
    blocker !== s.blocker;
  const terminal = ["failed", "completed", "preparing"].includes(s.state);
  const locked =
    busy || ["pushing", "creating"].includes(s.publication?.state || "");
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await api("/work/sessions/" + s.id + "/" + path, "POST", body);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copyPacket() {
    try {
      const p = await api("/work/sessions/" + s.id + "/packet");
      await navigator.clipboard.writeText(JSON.stringify(p, null, 2));
      setNotice("Context packet copied.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="session-editor">
      <div className="row-meta">
        <button className="button" onClick={() => open(s.itemId)}>
          {s.issueKey} ↗
        </button>
        <span>
          {s.state} · {s.owner === "human" ? "Human-owned" : "Agent-owned"}
        </span>
      </div>
      <h2>{s.title}</h2>
      <p>{s.objective}</p>
      <div className="branch-block">
        <GitBranch size={18} />
        <div>
          <strong>{s.branch}</strong>
          <code>{s.worktree}</code>
          <small>
            {s.repository.name} · from {s.repository.baseBranch} at{" "}
            {s.baseSha.slice(0, 12)}
          </small>
        </div>
      </div>
      {s.acceptance && (
        <>
          <h3>Done means</h3>
          <p className="preserve-text">{s.acceptance}</p>
        </>
      )}
      <div className="dev-actions">
        <button className="button" onClick={() => void copyPacket()}>
          <Copy size={14} /> Copy agent context
        </button>
        <span>{s.context.length} connected records</span>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {s.state === "failed" && s.steps.map((x, i) => <p key={i}>{x.detail}</p>)}
      {s.owner === "agent" && (
        <div className="agent-instructions">
          <h3>
            {s.leaseOwner ? "Agent has the next move" : "Ready for an agent"}
          </h3>
          <p>
            {s.leaseOwner
              ? `${s.leaseOwner} · lease ${Date.parse(s.leaseExpiresAt) > Date.now() ? "expires" : "expired"} ${new Date(s.leaseExpiresAt).toLocaleTimeString()}`
              : "Delegation saves a queue item. Start your agent separately and ask it to claim this session."}
          </p>
          <code>npm run agent -- claim {s.id} agent-name</code>
          <p>{s.nextAction}</p>
        </div>
      )}
      <WorkTimeline key={s.id} sessionId={s.id} />
      {!terminal && (
        <>
          <h3>Progress & evidence</h3>
          <fieldset disabled={locked || s.owner !== "human"}>
            <label>
              State
              <select value={state} onChange={(e) => setState(e.target.value)}>
                {["working", "blocked", "review", "completed"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Implementation summary
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
            <label>
              Tests & verification
              <textarea
                placeholder="Commands run, results and remaining gaps"
                value={tests}
                onChange={(e) => setTests(e.target.value)}
              />
            </label>
            <label>
              Next action
              <input value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label>
              Blocker
              <input
                value={blocker}
                onChange={(e) => setBlocker(e.target.value)}
              />
            </label>
            <button
              className="button primary"
              onClick={() =>
                void action("report", {
                  version: s.version,
                  state,
                  summary,
                  tests,
                  nextAction: next,
                  blocker,
                })
              }
            >
              Save progress
            </button>
          </fieldset>
          <h3>Pass the context, too.</h3>
          {s.owner === "human" && dirty && (
            <p>Save your progress before handing off.</p>
          )}
          <label>
            Handoff note
            <textarea
              value={handoff}
              onChange={(e) => setHandoff(e.target.value)}
              placeholder={
                s.owner === "agent"
                  ? "Why are you taking over, and what happens next?"
                  : "What should the agent do next? Include constraints."
              }
            />
          </label>
          <button
            className="button"
            disabled={
              locked || !handoff.trim() || (s.owner === "human" && dirty)
            }
            onClick={() =>
              void action("handoff", {
                version: s.version,
                to: s.owner === "human" ? "agent" : "human",
                summary: handoff,
              })
            }
          >
            {s.owner === "human"
              ? "Hand to an agent"
              : "Take over & revoke agent lease"}
          </button>
        </>
      )}
      {s.handoffs.length > 0 && (
        <details>
          <summary>Handoff history · {s.handoffs.length}</summary>
          {s.handoffs.map((h, i) => (
            <p key={i}>
              <strong>
                {h.from} → {h.to}
              </strong>
              <br />
              {h.summary}
            </p>
          ))}
        </details>
      )}
      {s.owner === "human" && !terminal && (
        <div className="publication">
          <h3>Ready to share the code?</h3>
          {s.publication ? (
            <>
              <p>
                {s.publication.state} · {s.publication.title}
              </p>
              <p>{s.publication.error}</p>
              {s.publication.url && (
                <a href={s.publication.url} target="_blank" rel="noreferrer">
                  Open draft MR ↗
                </a>
              )}
              {["failed", "prepared"].includes(s.publication.state) && (
                <button
                  className="button"
                  disabled={locked}
                  onClick={() =>
                    void action("prepare-publication", { title, description })
                  }
                >
                  Refresh publication preview
                </button>
              )}
              {s.publication.state === "prepared" && (
                <>
                  <code>{s.publication.sha}</code>
                  <p>
                    Push to {s.publication.remote}
                    <br />
                    Create a draft MR targeting {s.repository.baseBranch}.
                  </p>
                  <details>
                    <summary>Review MR description</summary>
                    <p className="preserve-text">{s.publication.description}</p>
                  </details>
                  <button
                    className="button primary"
                    disabled={locked}
                    onClick={() =>
                      void action("publish", { version: s.version })
                    }
                  >
                    {mode === "demo"
                      ? "Simulate publication"
                      : "Push branch & create draft MR"}
                  </button>
                </>
              )}
            </>
          ) : publishing ? (
            <>
              <label>
                MR title
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                Description
                <textarea
                  rows={9}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={locked}
                onClick={() =>
                  void action("prepare-publication", { title, description })
                }
              >
                Prepare publication preview
              </button>
            </>
          ) : (
            <>
              <p>
                Commit your work first. Review the exact commit and destination
                before publishing.
              </p>
              <button className="button" onClick={() => setPublishing(true)}>
                Prepare draft MR
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
export function RepositorySettings({
  value,
  onChange,
}: {
  value?: DevelopmentSettings;
  onChange: (v: DevelopmentSettings) => void;
}) {
  const d = value || { repositories: [], teamMembers: [] };
  const [teamText, setTeamText] = useState(d.teamMembers.join(", "));
  return (
    <section className="dev-settings">
      <h2>Local development</h2>
      <p>
        Register existing clones for isolated worktrees. Team usernames narrow
        the Team MRs view.
      </p>
      <label>
        Team GitLab usernames (comma-separated)
        <input
          value={teamText}
          onChange={(e) => {
            setTeamText(e.target.value);
            onChange({
              ...d,
              teamMembers: e.target.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            });
          }}
        />
      </label>
      {d.repositories.map((r, i) => (
        <div className="repo-fields" key={r.id}>
          {(["name", "path", "project", "baseBranch"] as const).map((k) => (
            <label key={k}>
              {
                {
                  name: "Name",
                  path: "Local clone path",
                  project: "GitLab host/group/project",
                  baseBranch: "Local base ref",
                }[k]
              }
              <input
                value={r[k]}
                onChange={(e) =>
                  onChange({
                    ...d,
                    repositories: d.repositories.map((x, j) =>
                      j === i ? { ...x, [k]: e.target.value } : x,
                    ),
                  })
                }
              />
            </label>
          ))}
          <button
            className="button"
            onClick={() =>
              onChange({
                ...d,
                repositories: d.repositories.filter((_, j) => j !== i),
              })
            }
          >
            Remove repository
          </button>
        </div>
      ))}
      <button
        className="button"
        onClick={() =>
          onChange({
            ...d,
            repositories: [
              ...d.repositories,
              {
                id: crypto.randomUUID(),
                name: "",
                path: "",
                project: "",
                baseBranch: "origin/main",
              },
            ],
          })
        }
      >
        Add local repository
      </button>
    </section>
  );
}
