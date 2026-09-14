import { RepositorySettings } from "./development";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  RefreshCw,
  Terminal,
  Download,
  ExternalLink,
  CheckCircle2,
  Circle,
  ChevronDown,
  LoaderCircle,
  AlertCircle,
  X,
} from "lucide-react";
import { api } from "./api";
import { SOURCES, type Source, type Snapshot } from "../shared/types";
import {
  TOOLS,
  AGENTS,
  type SetupOverview,
  type SetupState,
  type ToolDefinition,
} from "../shared/onboarding";
import "./onboarding.css";
const steps = [
  "Your services",
  "Install & connect",
  "Your agents",
  "Open your workspace",
];
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  return (
    <div className="setup-command">
      <code>{value}</code>
      <button
        className="button"
        aria-label="Copy command"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError(false);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? <Check size={15} /> : <Terminal size={15} />}{" "}
        {copied ? "Copied" : "Copy"}
      </button>
      {error && (
        <small role="alert">Select the command and copy it manually.</small>
      )}
    </div>
  );
}
export function SetupInvitation({ open }: { open: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let active = true;
    void api<SetupOverview>("/setup")
      .then((x) => {
        if (active) setShow(!x.state.dismissed && !x.state.completedAt);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!show) return null;
  return (
    <div className="setup-invitation">
      <div>
        <strong>Make this your workspace.</strong>
        <p>Connect your services and choose the agents you work with.</p>
      </div>
      <button className="button primary" onClick={open}>
        Set up Workroom <ArrowRight size={15} />
      </button>
      <button
        className="icon-button"
        aria-label="Dismiss setup invitation"
        onClick={async () => {
          try {
            const x = await api<SetupOverview>("/setup");
            await api("/setup/state", "POST", { ...x.state, dismissed: true });
            setShow(false);
          } catch {}
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
export function Onboarding({
  finish,
  exit,
}: {
  finish: (s: Snapshot) => void;
  exit: () => void;
}) {
  const [info, setInfo] = useState<SetupOverview>(),
    [draft, setDraft] = useState<SetupState>(),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [review, setReview] = useState<{ tool: string; installer: string }>();
  const [repoResults, setRepoResults] = useState<Record<string, string>>({});
  const [checkTime, setCheckTime] = useState(Date.now);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setCheckTime(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    void api<SetupOverview>("/setup")
      .then((x) => {
        if (active) {
          setInfo(x);
          setDraft(x.state);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [draft?.step]);
  useEffect(() => {
    if (info?.job?.state !== "running") return;
    const timer = setInterval(() => {
      void api<SetupOverview>("/setup")
        .then(setInfo)
        .catch((e) => setError(e.message));
    }, 2500);
    return () => clearInterval(timer);
  }, [info?.job?.state]);
  async function action(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function save(next: SetupState) {
    next = {
      ...next,
      configs: Object.fromEntries(
        SOURCES.map((s) => [
          s,
          {
            ...next.configs[s],
            repositories: next.configs[s].repositories
              .map((r) => r.trim())
              .filter(Boolean),
          },
        ]),
      ) as SetupState["configs"],
    };
    const x = await api<SetupOverview>("/setup/state", "POST", next);
    setInfo(x);
    setDraft(x.state);
    return x;
  }
  async function check() {
    await action("check", async () => {
      setInfo(await api<SetupOverview>("/setup/check", "POST", {}));
      setNotice(
        "Tool check complete. Installed tools still need account sign-in.",
      );
    });
  }
  if (!info || !draft)
    return (
      <div className="setup-loading" role="status">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button className="button" onClick={() => location.reload()}>
              Reload setup
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" /> Opening setup…
          </>
        )}
      </div>
    );
  const selected = TOOLS.filter((t) => draft.services.includes(t.id as Source));
  const currentChecks = info.connections.filter(
    (c) =>
      JSON.stringify(draft.configs[c.source]) ===
      JSON.stringify(info.state.configs[c.source]),
  );
  const ready = currentChecks.filter(
    (c) =>
      draft.services.includes(c.source) &&
      c.state === "ready" &&
      Math.max(checkTime, Date.now()) - Date.parse(c.checkedAt) < 600000,
  );
  const isBusy = !!busy;
  const move = (step: number) =>
    void action("save", async () => {
      await save({ ...draft, step });
      if (step === 1 || step === 2) {
        setBusy("check");
        setInfo(await api<SetupOverview>("/setup/check", "POST", {}));
      }
    });
  function change(source: Source, key: string, value: unknown) {
    setDraft((d) =>
      d
        ? {
            ...d,
            configs: {
              ...d.configs,
              [source]: { ...d.configs[source], [key]: value },
            },
          }
        : d,
    );
    setInfo((i) =>
      i
        ? {
            ...i,
            connections: i.connections.filter((c) => c.source !== source),
          }
        : i,
    );
  }
  function toolPanel(tool: ToolDefinition) {
    const status = info!.checks.find((c) => c.id === tool.id),
      available = status?.state === "available";
    const methods = tool.installers.filter((m) =>
      m.platforms.includes(info!.platform),
    );
    const chosen =
      review?.tool === tool.id
        ? methods.find((m) => m.id === review.installer)
        : undefined;
    const job = info!.job?.tool === tool.id ? info!.job : undefined;
    return (
      <div className="setup-tool-panel">
        <div className="setup-tool-status">
          <span
            className={`setup-status ${available ? "good" : status ? "warn" : ""}`}
          >
            {available ? (
              <CheckCircle2 size={15} />
            ) : status ? (
              <AlertCircle size={15} />
            ) : (
              <Circle size={15} />
            )}{" "}
            {available
              ? "CLI available"
              : status?.state === "missing"
                ? "CLI not installed"
                : status?.state === "incompatible"
                  ? "CLI needs an update"
                  : status
                    ? "CLI needs attention"
                    : "Not checked yet"}
          </span>
          {status?.version && <code>{status.version}</code>}
          <a href={tool.docs} target="_blank" rel="noreferrer">
            Official guide <ExternalLink size={13} />
          </a>
        </div>
        {status && <p className="setup-muted">{status.detail}</p>}
        {!available && (
          <div className="setup-install">
            <p>
              Install <code>{tool.executable}</code> on the machine running
              Workroom.
            </p>
            {methods.length ? (
              <div className="setup-methods">
                {methods.map((m) => (
                  <button
                    key={m.id}
                    className="button"
                    disabled={isBusy || info!.job?.state === "running"}
                    onClick={() =>
                      setReview({ tool: tool.id, installer: m.id })
                    }
                  >
                    <Download size={14} /> {m.label}
                  </button>
                ))}
              </div>
            ) : (
              <p>
                Use the official guide for this platform, then return here to
                check the installation.
              </p>
            )}
            {chosen && (
              <div className="setup-install-review">
                <h4>Review installation</h4>
                <Command value={[chosen.manager, ...chosen.args].join(" ")} />
                <p>
                  This downloads and runs {tool.name} and its dependencies as
                  your OS user. Your package manager selects the current
                  release. Existing installations may be updated. Workroom does
                  not request administrator access.
                </p>
                {!info!.managers[chosen.manager] ? (
                  <p className="setup-status warn">
                    {chosen.manager} is unavailable to Workroom. Install it
                    using its official guide or choose another method.
                  </p>
                ) : (
                  <button
                    className="button primary"
                    disabled={isBusy || info!.job?.state === "running"}
                    onClick={() =>
                      void action("install", async () => {
                        setInfo(
                          await api<SetupOverview>("/setup/install", "POST", {
                            tool: tool.id,
                            installer: chosen.id,
                            confirmed: true,
                          }),
                        );
                        setReview(undefined);
                      })
                    }
                  >
                    Install on this machine <ArrowRight size={14} />
                  </button>
                )}
                <button className="button" onClick={() => setReview(undefined)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
        {job && (
          <div className="setup-job" role="status">
            {job.state === "running" ? (
              <LoaderCircle className="spin" size={16} />
            ) : job.state === "succeeded" ? (
              <CheckCircle2 size={16} />
            ) : (
              <AlertCircle size={16} />
            )}
            <div>
              <strong>
                {job.state === "running"
                  ? "Installation in progress"
                  : job.state === "succeeded"
                    ? "Installation finished"
                    : job.state === "interrupted"
                      ? "Installation needs checking"
                      : "Installation needs attention"}
              </strong>
              <p>{job.detail}</p>
              {job.state !== "running" && (
                <button
                  className="button"
                  disabled={isBusy}
                  onClick={() => void check()}
                >
                  Recheck tools
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
  function loginCommand(tool: ToolDefinition) {
    if (tool.id === "codex") return "codex login";
    if (tool.id === "claude") return "claude auth login";
    if (tool.id === "cline") return "cline auth";
    if (tool.id === "gitlab") {
      const project = draft!.configs.gitlab.repositories[0] || "";
      const host =
        project.split("/").length > 2 ? project.split("/")[0] : "gitlab.com";
      return "glab auth login --hostname " + quote(host);
    }
    const profile = draft!.configs[tool.id as Source].profile;
    return [
      tool.executable,
      ...(profile ? ["--profile", quote(profile)] : []),
      tool.id === "outlook" ? "auth login" : "init",
    ].join(" ");
  }
  return (
    <div className="setup-page">
      <header className="setup-header">
        <div>
          <h1>Make room for your work.</h1>
          <p>Bring the right services and agents into one local workspace.</p>
        </div>
        <button
          className="button"
          disabled={isBusy}
          onClick={() =>
            void action("exit", async () => {
              await save({ ...draft, dismissed: true });
              exit();
            })
          }
        >
          Finish later
        </button>
      </header>
      <div className="setup-layout">
        <nav className="setup-steps" aria-label="Setup progress">
          {steps.map((s, i) => (
            <button
              key={s}
              disabled={isBusy}
              aria-current={draft.step === i ? "step" : undefined}
              onClick={() => move(i)}
            >
              <span>{i + 1}</span>
              <div>
                <strong>{s}</strong>
                <small>
                  {
                    [
                      "Start with what matters",
                      "On this work machine",
                      "Optional, always your choice",
                      "A live inbox, ready to use",
                    ][i]
                  }
                </small>
              </div>
            </button>
          ))}
          <p>
            Your progress stays on this machine. Add more services whenever you
            need them.
          </p>
          <a
            href="#Connections"
            onClick={(e) => {
              e.preventDefault();
              exit();
            }}
          >
            Open advanced connections
          </a>
        </nav>
        <section className="setup-content" aria-busy={isBusy}>
          <div className="setup-step-heading">
            <h2 ref={heading} tabIndex={-1}>
              {
                [
                  "What should Workroom bring together?",
                  "Connect your first source.",
                  "Choose how you want to work.",
                  "Your workspace starts here.",
                ][draft.step]
              }
            </h2>
            <p>
              {
                [
                  "Choose any combination. One working connection is enough to begin.",
                  "Install missing tools, sign in through their own terminal flow, then verify the work you will see.",
                  "Choose one agent, several, or none. Your agent keeps its own model and approval settings.",
                  "Only the verified sources below will be enabled. Other choices stay saved for later.",
                ][draft.step]
              }
            </p>
          </div>
          {error && (
            <div className="alert" role="alert">
              {error}{" "}
              <button className="button" onClick={() => location.reload()}>
                Reload saved setup
              </button>
            </div>
          )}
          {notice && (
            <p className="setup-feedback" role="status">
              {notice}
            </p>
          )}
          {draft.step === 0 && (
            <div className="setup-choices">
              {TOOLS.filter((t) => SOURCES.includes(t.id as Source)).map(
                (t) => (
                  <label
                    key={t.id}
                    className={
                      draft.services.includes(t.id as Source) ? "chosen" : ""
                    }
                  >
                    <img src={`/logos/${t.id}.svg`} alt="" />
                    <span>
                      <strong>{t.name}</strong>
                      <small>{t.purpose}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.services.includes(t.id as Source)}
                      disabled={isBusy}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          services: e.target.checked
                            ? [...draft.services, t.id as Source]
                            : draft.services.filter((s) => s !== t.id),
                        })
                      }
                    />
                  </label>
                ),
              )}
              <p className="setup-local-note">
                Credentials stay with your CLIs. Workroom stores the collected
                work and your private notes locally.
              </p>
            </div>
          )}
          {draft.step === 1 && (
            <>
              <div className="setup-toolbar">
                <span>
                  {selected.length}{" "}
                  {selected.length === 1 ? "source" : "sources"} selected ·{" "}
                  {info.platform === "darwin" ? "macOS" : info.platform}
                </span>
                <button
                  className="button"
                  disabled={isBusy}
                  onClick={() => void check()}
                >
                  <RefreshCw
                    size={14}
                    className={busy === "check" ? "spin" : ""}
                  />{" "}
                  {busy === "check"
                    ? "Checking this machine…"
                    : "Recheck tools"}
                </button>
              </div>
              {!selected.length && (
                <div className="setup-empty">
                  <h3>Start with one service.</h3>
                  <p>You can explore Workroom without connecting anything.</p>
                  <button className="button" onClick={() => move(0)}>
                    Choose a service
                  </button>
                </div>
              )}
              {selected.map((tool, index) => {
                const source = tool.id as Source,
                  c = draft.configs[source],
                  verified = currentChecks.find((x) => x.source === source),
                  expired =
                    verified?.state === "ready" &&
                    !ready.some((x) => x.source === source);
                return (
                  <details
                    className="setup-source"
                    key={source}
                    open={
                      selected.length === 1 || index === 0 ? true : undefined
                    }
                  >
                    <summary>
                      <img src={`/logos/${source}.svg`} alt="" />
                      <strong>{tool.name}</strong>
                      <span
                        className={
                          verified?.state === "ready" && !expired ? "good" : ""
                        }
                      >
                        {expired
                          ? "Recheck connection"
                          : verified?.state === "ready"
                            ? `${verified.count} items found`
                            : verified?.state === "error"
                              ? "Needs attention"
                              : "Set up connection"}
                      </span>
                      <ChevronDown size={16} className="setup-chevron" />
                    </summary>
                    <div className="setup-source-body">
                      {toolPanel(tool)}
                      <div className="setup-config">
                        {source !== "gitlab" && (
                          <label>
                            CLI profile{" "}
                            <input
                              value={c.profile}
                              disabled={isBusy}
                              placeholder="Default profile"
                              onChange={(e) =>
                                change(source, "profile", e.target.value)
                              }
                            />
                            <small>
                              Use the same profile when signing in below.
                            </small>
                          </label>
                        )}
                        {source === "gitlab" ? (
                          <label>
                            GitLab projects
                            <textarea
                              disabled={isBusy}
                              rows={3}
                              value={c.repositories.join("\n")}
                              placeholder="gitlab.example.com/team/project"
                              onChange={(e) =>
                                change(
                                  source,
                                  "repositories",
                                  e.target.value.split("\n"),
                                )
                              }
                            />
                            <small>
                              One host/group/project per line. Includes your MRs
                              and team reviews in these projects.
                            </small>
                          </label>
                        ) : (
                          <label>
                            {source === "jira"
                              ? "Jira query (JQL)"
                              : source === "outlook"
                                ? "Email search (optional)"
                                : "Incident query (optional)"}
                            <textarea
                              rows={2}
                              disabled={isBusy}
                              value={c.query}
                              onChange={(e) =>
                                change(source, "query", e.target.value)
                              }
                              placeholder={
                                source === "jira"
                                  ? "assignee = currentUser() AND statusCategory != Done"
                                  : source === "outlook"
                                    ? "Leave empty for recent email"
                                    : "Leave empty for incidents assigned to you or your groups"
                              }
                            />
                            <small>
                              {source === "jira"
                                ? "Using a test project? Enter project = YOURKEY to include unassigned tickets."
                                : source === "outlook"
                                  ? "Email is collected per message; subject matches are suggestions."
                                  : "The default query includes active incidents for you and your groups."}
                            </small>
                          </label>
                        )}
                        {source === "outlook" && (
                          <label>
                            Mail folder
                            <input
                              disabled={isBusy}
                              value={c.folder}
                              placeholder="inbox"
                              onChange={(e) =>
                                change(source, "folder", e.target.value)
                              }
                            />
                          </label>
                        )}
                        {(source === "jira" || source === "servicenow") && (
                          <label>
                            {source === "jira"
                              ? "Jira site URL"
                              : "ServiceNow instance URL"}
                            <input
                              type="url"
                              disabled={isBusy}
                              value={c.baseUrl}
                              placeholder={
                                source === "jira"
                                  ? "https://your-team.atlassian.net"
                                  : "https://your-team.service-now.com"
                              }
                              onChange={(e) =>
                                change(source, "baseUrl", e.target.value)
                              }
                            />
                            <small>
                              Used for source links. The CLI profile determines
                              which account and host are queried.
                            </small>
                          </label>
                        )}
                      </div>
                      <div className="setup-signin">
                        <h3>Sign in from your terminal</h3>
                        <Command value={loginCommand(tool)} />
                        <p>
                          Run this on the Workroom host. Complete any browser
                          login or token entry in the CLI’s own setup. Then
                          return here.
                        </p>
                        {source === "jira" &&
                          info.checks.find((x) => x.id === "jira")
                            ?.guidedAuth === false && (
                            <p className="setup-status warn">
                              This Jira CLI has the older setup flow. Its init
                              command prints instructions; use the official
                              guide or update the CLI for guided sign-in.
                            </p>
                          )}
                      </div>
                      <button
                        className="button primary"
                        disabled={isBusy || info.job?.state === "running"}
                        onClick={() =>
                          void action(source, async () => {
                            const next = {
                              ...draft,
                              configs: {
                                ...draft.configs,
                                [source]: {
                                  ...c,
                                  repositories: c.repositories
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                },
                              },
                            };
                            await save(next);
                            setInfo(
                              await api<SetupOverview>(
                                `/setup/verify/${source}`,
                                "POST",
                                {},
                              ),
                            );
                          })
                        }
                      >
                        {busy === source ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <CheckCircle2 size={15} />
                        )}{" "}
                        {busy === source
                          ? "Checking access and query…"
                          : "Save & verify connection"}
                      </button>
                      {verified && (
                        <div
                          className={`setup-verification ${expired ? "error" : verified.state}`}
                          role="status"
                        >
                          <strong>
                            {expired
                              ? "Verification expired"
                              : verified.state === "ready"
                                ? "Connection verified"
                                : "Connection needs attention"}
                          </strong>
                          <p>
                            {expired
                              ? "Checks stay valid for ten minutes. Save and verify this connection again before opening your live inbox."
                              : verified.detail}
                          </p>
                          {verified.sample.length > 0 && (
                            <ul>
                              {verified.sample.map((row) => (
                                <li key={row.key}>
                                  <code>{row.key}</code> {row.title}
                                </li>
                              ))}
                            </ul>
                          )}
                          {verified.limited && (
                            <small>
                              The CLI cannot establish a complete count. More
                              work may exist beyond this snapshot.
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                );
              })}
            </>
          )}
          {draft.step === 2 && (
            <>
              <div className="setup-choices">
                {AGENTS.map((id) => {
                  const tool = TOOLS.find((t) => t.id === id)!;
                  return (
                    <label
                      key={id}
                      className={draft.agents.includes(id) ? "chosen" : ""}
                    >
                      <Terminal size={26} />
                      <span>
                        <strong>
                          {tool.name}{" "}
                          <em>
                            {tool.native
                              ? "Native terminal workflow"
                              : "Manual reporting"}
                          </em>
                        </strong>
                        <small>{tool.purpose}</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={draft.agents.includes(id)}
                        disabled={isBusy}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            agents: e.target.checked
                              ? [...draft.agents, id]
                              : draft.agents.filter((a) => a !== id),
                          })
                        }
                      />
                    </label>
                  );
                })}
              </div>
              <p className="setup-local-note">
                No agent is selected by default. Selecting an agent makes it
                available in work sessions; it does not launch a task or change
                its permissions.
              </p>
              {draft.agents.map((id) => {
                const tool = TOOLS.find((t) => t.id === id)!;
                return (
                  <section className="setup-agent" key={id}>
                    <h3>{tool.name}</h3>
                    {toolPanel(tool)}
                    <h4>Sign in with {tool.name}</h4>
                    <Command value={loginCommand(tool)} />
                    <p className="setup-muted">
                      Complete sign-in in your terminal. Installation checks do
                      not verify your provider account or model access.
                    </p>
                  </section>
                );
              })}
              <details className="setup-repo-note">
                <summary>
                  <strong>Add local repositories (optional)</strong>
                </summary>
                <p>
                  Choose existing clones for isolated branches and worktrees.
                  You can add these later.
                </p>
                <RepositorySettings
                  value={draft.development}
                  onChange={(development) => {
                    setDraft({ ...draft, development });
                    setRepoResults({});
                  }}
                />
                {draft.development.repositories.map((r) => (
                  <div key={r.id} className="setup-repo-check">
                    <button
                      className="button"
                      disabled={isBusy}
                      onClick={() =>
                        void action("repository", async () => {
                          await save(draft);
                          const result = await api<{
                            detail: string;
                            warnings: string[];
                          }>(
                            `/setup/repository/${encodeURIComponent(r.id)}`,
                            "POST",
                            {},
                          );
                          setRepoResults((old) => ({
                            ...old,
                            [r.id]:
                              result.detail + " " + result.warnings.join(" "),
                          }));
                        })
                      }
                    >
                      Verify {r.name || "repository"}
                    </button>
                    {repoResults[r.id] && (
                      <p role="status">{repoResults[r.id]}</p>
                    )}
                  </div>
                ))}
                <p>
                  {info.managers.git
                    ? "Git is installed."
                    : "Git has not been detected. Install it before creating worktrees."}{" "}
                  Repository checks do not fetch, switch branches or edit files.
                </p>
              </details>
            </>
          )}
          {draft.step === 3 && (
            <>
              <div className="setup-review-list">
                {selected.map((t) => {
                  const c = ready.find((r) => r.source === t.id);
                  const expired =
                    !c &&
                    currentChecks.some(
                      (r) => r.source === t.id && r.state === "ready",
                    );
                  return (
                    <div key={t.id}>
                      <img src={`/logos/${t.id}.svg`} alt="" />
                      <span>
                        <strong>{t.name}</strong>
                        <small>
                          {c
                            ? `${c.count} items · verified ${new Date(c.checkedAt).toLocaleTimeString()}`
                            : expired
                              ? "Verification expired · recheck before enabling this source"
                              : "Saved for later · verify this connection to enable it"}
                        </small>
                      </span>
                      {c ? (
                        <CheckCircle2 className="good" size={20} />
                      ) : (
                        <button className="button" onClick={() => move(1)}>
                          {expired ? "Recheck" : "Connect"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="setup-summary">
                <h3>
                  {ready.length
                    ? "Ready for your first live view."
                    : "Connect one source to begin."}
                </h3>
                <p>
                  {ready.length
                    ? `${ready.reduce((n, c) => n + c.count, 0)} items found across ${ready.length} verified ${ready.length === 1 ? "source" : "sources"}. Workroom will refresh these sources when you open the inbox.`
                    : "Finish later to return to your workspace. Your choices are saved."}
                </p>
                <p>
                  {draft.agents.length
                    ? `Agents selected: ${draft.agents.map((a) => TOOLS.find((t) => t.id === a)!.name).join(", ")}. Choose an agent explicitly when starting work.`
                    : "You will work without an agent for now. Add one whenever you need it."}
                </p>
                <p>
                  Live comments, status changes and MR publication are prepared
                  for human review.
                </p>
              </div>
            </>
          )}
          <footer className="setup-footer">
            {draft.step > 0 && (
              <button
                className="button"
                disabled={isBusy}
                onClick={() => move(draft.step - 1)}
              >
                <ArrowLeft size={15} /> Back
              </button>
            )}
            <span>
              {busy === "save"
                ? "Saving your choices…"
                : `Step ${draft.step + 1} of ${steps.length}`}
            </span>
            {draft.step < 3 ? (
              <button
                className="button primary"
                disabled={isBusy}
                onClick={() => move(draft.step + 1)}
              >
                {draft.step === 2 && !draft.agents.length
                  ? "Continue without an agent"
                  : "Continue"}{" "}
                <ArrowRight size={15} />
              </button>
            ) : (
              <button
                className="button primary"
                disabled={
                  isBusy || !ready.length || info.job?.state === "running"
                }
                onClick={() =>
                  void action("finish", async () => {
                    const saved = await save(draft);
                    finish(
                      await api<Snapshot>("/setup/finish", "POST", {
                        version: saved.state.version,
                      }),
                    );
                  })
                }
              >
                {busy === "finish"
                  ? "Collecting your work…"
                  : "Open my live inbox"}{" "}
                <ArrowRight size={15} />
              </button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
