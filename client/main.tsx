import {
  MrWorkspace,
  SessionWorkspace,
  StartWork,
  RepositorySettings,
} from "./development";
import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Inbox,
  Layers,
  Clock3,
  Settings2,
  Search,
  RefreshCw,
  ArrowUpRight,
  ArrowLeft,
  Check,
  ChevronRight,
  GitPullRequest,
  GitBranch,
  MessageSquare,
  FileText,
  Activity as ActivityIcon,
  ShieldCheck,
  PanelLeftClose,
  AlertTriangle,
  X,
  ArrowRight,
  Link2,
  CheckCheck,
  CheckCircle2,
  LoaderCircle,
} from "lucide-react";
import { api } from "./api";
import {
  SOURCES,
  type Source,
  type WorkItem,
  type Snapshot,
  type Detail,
  type Settings,
  type Proposal,
  type Activity,
  type Link,
} from "../shared/types";
import "./style.css";
const names: Record<Source, string> = {
  jira: "Jira",
  gitlab: "GitLab",
  servicenow: "ServiceNow",
  outlook: "Outlook",
};
const fmt = (value: string) => {
  if (!value) return "Not observed";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const ago = (value: string | null) => {
  if (!value) return "Not refreshed";
  const delta = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 60000),
  );
  if (!Number.isFinite(delta)) return value;
  return delta < 1
    ? "Just now"
    : delta < 60
      ? `${delta} min ago`
      : delta < 1440
        ? `${Math.floor(delta / 60)}h ago`
        : `${Math.floor(delta / 1440)}d ago`;
};
function Logo({ source, size = 18 }: { source: Source; size?: number }) {
  return (
    <img
      className="service-logo"
      src={`/logos/${source}.svg`}
      alt=""
      width={size}
      height={size}
    />
  );
}
function SourceLabel({ source }: { source: Source }) {
  return (
    <span className="source">
      <Logo source={source} />
      {names[source]}
    </span>
  );
}
function Status({ item }: { item: WorkItem }) {
  return (
    <span
      className={`badge ${item.score >= 90 ? "urgent" : /block/i.test(item.status) ? "warning" : item.closed ? "quiet" : ""}`}
    >
      {item.status || "Unknown status"}
    </span>
  );
}
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [view, setView] = useState(() => {
    const route = decodeURIComponent(location.hash.slice(1));
    return [
      "Attention",
      "My work",
      "Merge requests",
      "Work sessions",
      "Snoozed",
      "Agent desk",
      "Activity",
      "Connections",
    ].includes(route)
      ? route
      : "Attention";
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = (s: string) => setToast(s);
  async function load() {
    try {
      setSnapshot(await api<Snapshot>("/snapshot"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    if (location.hash === "#Connections")
      void api<Settings>("/settings")
        .then(setSettings)
        .catch((e) => setError(e.message));
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  async function refresh(source?: Source) {
    setRefreshing(true);
    try {
      setSnapshot(await api<Snapshot>("/sync", "POST", { source }));
      notify(
        source
          ? `${names[source]} refresh finished.`
          : "Refresh finished. See source status for any connection issues.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  async function navigate(next: string) {
    setView(next);
    history.replaceState(null, "", "#" + encodeURIComponent(next));
    setSelected(null);
    setFilter("All");
    setSearch("");
    if (next === "Connections")
      try {
        setSettings(await api<Settings>("/settings"));
      } catch (e) {
        setError((e as Error).message);
      }
  }
  const items = snapshot?.items || [];
  const active = items.filter(
    (i) =>
      !i.closed &&
      (!i.snoozedUntil || new Date(i.snoozedUntil).getTime() <= Date.now()),
  );
  const pending =
    snapshot?.proposals.filter((p) => p.state === "pending") || [];
  const linkedIds = new Set(
    snapshot?.links
      .filter((l) => l.state !== "dismissed")
      .flatMap((l) => [l.from, l.to]) || [],
  );
  const attention = active.filter(
    (i) =>
      (i.source !== "outlook" || linkedIds.has(i.id)) &&
      (i.source !== "gitlab" || i.score > 0),
  );
  const visible = (
    view === "Snoozed"
      ? items.filter(
          (i) =>
            i.snoozedUntil && new Date(i.snoozedUntil).getTime() > Date.now(),
        )
      : view === "My work"
        ? items.filter((i) => i.source === "jira")
        : attention
  )
    .filter(
      (i) =>
        filter === "All" ||
        (filter === "Incidents" && i.source === "servicenow") ||
        (filter === "Merge requests" && i.source === "gitlab") ||
        (filter === "Blocked" && /block/i.test(i.status)) ||
        (filter === "Email" && i.source === "outlook"),
    )
    .filter((i) =>
      (i.key + " " + i.title + " " + i.description + " " + i.assignee)
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt),
    );
  const sourceErrors =
    snapshot?.connectors.filter((c) => c.enabled && c.error) || [];
  return (
    <>
      <div className="app-shell" inert={!!selected}>
        <aside className="sidebar">
          <a className="brand" href="/" aria-label="Workroom home">
            <span className="brand-mark">
              <Layers size={19} strokeWidth={1.8} />
            </span>
            workroom<span className="beta">LOCAL</span>
          </a>
          <div className="workspace-label">PERSONAL WORKSPACE</div>
          <nav aria-label="Main navigation">
            {[
              { name: "Attention", icon: Inbox, count: attention.length },
              { name: "My work", icon: Layers },
              { name: "Merge requests", icon: GitPullRequest },
              {
                name: "Work sessions",
                icon: GitBranch,
                count: snapshot?.sessions?.filter(
                  (s) => s.owner === "human" && s.state === "review",
                ).length,
              },
              { name: "Snoozed", icon: Clock3 },
              { name: "Agent desk", icon: ShieldCheck, count: pending.length },
              { name: "Activity", icon: ActivityIcon },
              { name: "Connections", icon: Settings2 },
            ].map((n) => (
              <button
                key={n.name}
                className={view === n.name ? "active" : ""}
                onClick={() => void navigate(n.name)}
                aria-current={view === n.name ? "page" : undefined}
              >
                <n.icon size={18} />
                <span>{n.name}</span>
                {n.count !== undefined && <small>{n.count}</small>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="dock">
              {SOURCES.map((s) => (
                <span key={s} title={names[s]}>
                  <Logo source={s} size={21} />
                  <span
                    className={`dock-dot ${snapshot?.connectors.find((c) => c.source === s)?.enabled ? "on" : ""}`}
                  />
                </span>
              ))}
            </div>
            <div className="profile">
              <span className="avatar">ME</span>
              <div>
                <strong>Your workspace</strong>
                <small>
                  {snapshot?.mode === "demo"
                    ? "Demo collection"
                    : "Local to this machine"}
                </small>
              </div>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              Workspace <ChevronRight size={14} />
              <strong>{view}</strong>
            </div>
            <div className="search">
              <Search size={16} />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your work…"
                aria-label="Search your work"
              />
              <kbd>⌘ K</kbd>
            </div>
            <span
              className={`mode-label ${snapshot?.mode === "demo" ? "demo" : ""}`}
            >
              <span className="dot" />
              {snapshot?.mode === "demo" ? "Demo mode" : "Local workspace"}
            </span>
          </header>
          {snapshot?.mode === "demo" && (
            <div className="demo-banner">
              <span>
                Exploring with sample data. Notes and changes persist in a
                separate demo collection.
              </span>
              <button onClick={() => void navigate("Connections")}>
                Connect your tools <ArrowRight size={14} />
              </button>
            </div>
          )}
          <main>
            {error && (
              <div className="alert" role="alert">
                <AlertTriangle size={17} />
                <span>{error}</span>
                <button onClick={() => void load()}>Retry</button>
              </div>
            )}
            {!snapshot ? (
              <div className="loading">
                <LoaderCircle className="spin" />
                Opening your workspace…
              </div>
            ) : view === "Connections" ? (
              <Connections
                settings={settings}
                snapshot={snapshot}
                refresh={refresh}
                refreshing={refreshing}
                save={async (s) => {
                  try {
                    const next = await api<Settings>("/settings", "PUT", s);
                    setSettings(next);
                    await load();
                    notify(
                      "Connection settings saved. Refresh to collect data.",
                    );
                  } catch (e) {
                    throw e;
                  }
                }}
              />
            ) : view === "Merge requests" ? (
              <MrWorkspace
                snapshot={snapshot}
                open={setSelected}
                search={search}
              />
            ) : view === "Work sessions" ? (
              <SessionWorkspace
                snapshot={snapshot}
                reload={load}
                open={setSelected}
              />
            ) : view === "Agent desk" ? (
              <AgentDesk
                snapshot={snapshot}
                reload={load}
                notify={notify}
                open={setSelected}
              />
            ) : view === "Activity" ? (
              <ActivityView mode={snapshot.mode} />
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <h1>
                      {view === "Attention"
                        ? "A clear start to your day."
                        : view === "My work"
                          ? "Your work, in context."
                          : "Set aside. Not forgotten."}
                    </h1>
                    <p>
                      {view === "Attention"
                        ? `${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · ${attention.length} items need your attention`
                        : view === "My work"
                          ? "Every Jira ticket, with the rest of the story attached."
                          : "Snoozed items return to attention automatically when their time is up."}
                    </p>
                  </div>
                  <button
                    className="button"
                    disabled={refreshing || snapshot.syncing}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={15} className={refreshing ? "spin" : ""} />
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
                {sourceErrors.length > 0 && (
                  <div className="notice">
                    <AlertTriangle size={16} />
                    <span>
                      {sourceErrors.map((c) => names[c.source]).join(", ")}{" "}
                      could not refresh. Last successful data is retained.
                    </span>
                    <button onClick={() => void navigate("Connections")}>
                      Check connections
                    </button>
                  </div>
                )}
                <div className="filters" aria-label="Filter work">
                  {[
                    "All",
                    "Incidents",
                    "Merge requests",
                    "Blocked",
                    "Email",
                  ].map((f) => (
                    <button
                      key={f}
                      className={filter === f ? "active" : ""}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {f}
                    </button>
                  ))}
                  <span>
                    {visible.length} {visible.length === 1 ? "item" : "items"} ·
                    urgency first
                  </span>
                </div>
                <div
                  className={`work-layout ${selected ? "has-selection" : ""}`}
                >
                  <section className="work-list" aria-label="Work items">
                    <div className="list-caption">
                      <h2>
                        {view === "Snoozed"
                          ? "Snoozed work"
                          : "Needs your attention"}
                      </h2>
                      <span>Updated</span>
                    </div>
                    {visible.length === 0 ? (
                      <Empty
                        icon={CheckCheck}
                        title={
                          search
                            ? "No matches for that search"
                            : view === "Snoozed"
                              ? "Nothing snoozed"
                              : snapshot.mode === "live" &&
                                  !snapshot.connectors.some((c) => c.enabled)
                                ? "Bring your tools together"
                                : "You’re clear here"
                        }
                        text={
                          search
                            ? "Try a ticket key, title or another filter."
                            : snapshot.mode === "live"
                              ? "Set up your connections, then refresh to collect work."
                              : "Try another filter or check back after the next refresh."
                        }
                        action={
                          snapshot.mode === "live"
                            ? () => void navigate("Connections")
                            : undefined
                        }
                        label="Set up connections"
                      />
                    ) : (
                      visible.map((item) => (
                        <button
                          key={item.id}
                          className={`work-row ${selected === item.id ? "selected" : ""}`}
                          onClick={() => setSelected(item.id)}
                        >
                          <span className="row-meta">
                            <SourceLabel source={item.source} />
                            <span className="record-key">
                              {item.source === "outlook" ? "MAIL" : item.key}
                            </span>
                            <Status item={item} />
                            <time>{ago(item.updatedAt)}</time>
                          </span>
                          <span className="row-title">{item.title}</span>
                          <span className="row-reason">
                            {view === "Snoozed"
                              ? `Returns ${fmt(item.snoozedUntil!)}`
                              : item.reason}
                          </span>
                          <RelatedChips item={item} snapshot={snapshot} />
                        </button>
                      ))
                    )}
                  </section>
                  <aside className="context-sidebar">
                    <div className="brief">
                      <span className="brief-symbol">
                        <Link2 size={21} />
                      </span>
                      <h2>The bigger picture</h2>
                      <p>
                        Your sources become more useful together. Open a work
                        item to see its related tickets, merge requests and
                        email.
                      </p>
                      <div className="brief-stat">
                        <strong>
                          {
                            snapshot.links.filter(
                              (l) => l.state !== "dismissed",
                            ).length
                          }
                        </strong>
                        <span>relationships in this workspace</span>
                      </div>
                      {pending.length > 0 && (
                        <button
                          className="text-button"
                          onClick={() => void navigate("Agent desk")}
                        >
                          {pending.length} proposed{" "}
                          {pending.length === 1 ? "update" : "updates"} to
                          review <ArrowRight size={15} />
                        </button>
                      )}
                    </div>
                    <div className="freshness">
                      <h2>Source freshness</h2>
                      {snapshot.connectors.map((c) => (
                        <button
                          className="freshness-row"
                          key={c.source}
                          onClick={() => void navigate("Connections")}
                        >
                          <SourceLabel source={c.source} />
                          <span className={c.error ? "danger" : ""}>
                            {!c.enabled
                              ? "Not connected"
                              : c.error
                                ? "Needs attention"
                                : snapshot.mode === "demo"
                                  ? "Sample data"
                                  : ago(c.lastSuccess)}
                          </span>
                        </button>
                      ))}
                      <p>
                        Each source refreshes independently. Records keep their
                        last observation time.
                      </p>
                    </div>
                    <div className="quiet-tip">
                      <Clock3 size={16} />
                      <p>
                        Make room for what matters. Snooze an item from its
                        details and return to it later.
                      </p>
                    </div>
                  </aside>
                </div>
              </>
            )}
          </main>
          <footer className="app-footer">
            <span>
              <span className="dot" />
              Stored on this machine
            </span>
            <span>Workroom · 0.1</span>
          </footer>
        </div>
      </div>
      {selected && snapshot && (
        <DetailPane
          key={`${snapshot.mode}:${selected}`}
          id={selected}
          mode={snapshot.mode}
          close={() => setSelected(null)}
          changed={load}
          notify={notify}
          open={setSelected}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
    </>
  );
}
function RelatedChips({
  item,
  snapshot,
}: {
  item: WorkItem;
  snapshot: Snapshot;
}) {
  const relations = snapshot.links.filter(
    (l) => l.state !== "dismissed" && (l.from === item.id || l.to === item.id),
  );
  const related = relations
    .map((l) =>
      snapshot.items.find((i) => i.id === (l.from === item.id ? l.to : l.from)),
    )
    .filter((i): i is WorkItem => !!i);
  return (
    <span className="related-chips">
      {related.slice(0, 4).map((i) => (
        <span key={i.id}>
          <Logo source={i.source} size={13} />
          {i.source === "outlook" ? "Email" : i.key}
        </span>
      ))}
      {related.length > 4 && <span>+{related.length - 4} more</span>}
      {item.kind === "mr" && item.raw.head_pipeline?.status && (
        <span className="pipeline">
          <Check size={13} />
          {item.raw.head_pipeline.status}
        </span>
      )}
    </span>
  );
}
function Empty({
  icon: Icon = Inbox,
  title,
  text,
  action,
  label,
}: {
  icon?: any;
  title: string;
  text: string;
  action?: () => void;
  label?: string;
}) {
  return (
    <div className="empty">
      <Icon size={28} strokeWidth={1.3} />
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button className="button" onClick={action}>
          {label}
        </button>
      )}
    </div>
  );
}
function DetailPane({
  id,
  mode,
  close,
  changed,
  notify,
  open,
}: {
  id: string;
  mode: string;
  close: () => void;
  changed: () => Promise<void>;
  notify: (s: string) => void;
  open: (id: string) => void;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Context");
  const [note, setNote] = useState("");
  const [body, setBody] = useState("");
  const [transition, setTransition] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal>();
  const [confirmSnooze, setConfirmSnooze] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  async function load() {
    try {
      const d = await api<Detail>("/items/" + encodeURIComponent(id));
      setDetail(d);
      setNote(d.item.note || "");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const prev = document.activeElement as HTMLElement;
    closeRef.current?.focus();
    return () => prev?.focus();
  }, [id]);
  useEffect(() => {
    function focusTrap(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const all = panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input, textarea, select",
      );
      if (!all?.length) return;
      const first = all[0],
        last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", focusTrap);
    return () => document.removeEventListener("keydown", focusTrap);
  }, []);
  async function local(values: object, message: string) {
    setBusy(true);
    try {
      await api("/items/" + encodeURIComponent(id) + "/local", "PATCH", values);
      await changed();
      notify(message);
      if ("snoozedUntil" in values) close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function propose(action: Proposal["action"], value: string) {
    if (!detail) return;
    setBusy(true);
    try {
      const p = await api<Proposal>("/proposals", "POST", {
        itemId: id,
        action,
        body: value,
        expectedUpdatedAt: detail.item.updatedAt,
      });
      setProposal(p);
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!proposal) return;
    setBusy(true);
    try {
      const p = await api<Proposal>(
        "/proposals/" + proposal.id + "/execute",
        "POST",
        {},
      );
      setProposal(p);
      await changed();
      if (p.state === "succeeded") {
        setBody("");
        setTransition("");
        await load();
        notify(p.result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail-overlay">
      <div className="backdrop" onClick={close} />
      <section
        ref={panelRef}
        className="detail-pane"
        role="dialog"
        aria-modal="true"
        aria-label="Work item details"
      >
        <header className="detail-top">
          <span>Connected work</span>
          <button
            ref={closeRef}
            className="icon-button"
            onClick={close}
            aria-label="Close details"
          >
            <X size={20} />
          </button>
        </header>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!detail ? (
          <div className="loading">
            <LoaderCircle className="spin" />
            Loading details…
          </div>
        ) : (
          <>
            <div className="detail-heading">
              <div className="row-meta">
                <SourceLabel source={detail.item.source} />
                <span className="record-key">
                  {detail.item.source === "outlook" ? "Email" : detail.item.key}
                </span>
                {detail.item.url && (
                  <a
                    href={detail.item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="source-link"
                  >
                    Open source <ArrowUpRight size={14} />
                  </a>
                )}
              </div>
              <h1>{detail.item.title}</h1>
              {detail.item.source === "jira" && !detail.item.closed && (
                <details>
                  <summary className="button">
                    Start work · branch & handoff
                  </summary>
                  <StartWork
                    key={detail.item.id}
                    item={detail.item}
                    done={() => void changed()}
                  />
                </details>
              )}
              <div className="detail-meta">
                <div>
                  <small>Status</small>
                  <Status item={detail.item} />
                </div>
                <div>
                  <small>Assigned to</small>
                  <span>{detail.item.assignee || "Unassigned"}</span>
                </div>
                <div>
                  <small>Priority</small>
                  <span>{detail.item.priority || "Not set"}</span>
                </div>
              </div>
              <p className="description">
                {detail.item.description ||
                  "No description in the current source record."}
              </p>
              <div className="detail-actions">
                <button
                  className="button"
                  onClick={() => setConfirmSnooze(!confirmSnooze)}
                >
                  <Clock3 size={15} />
                  {detail.item.snoozedUntil &&
                  new Date(detail.item.snoozedUntil) > new Date()
                    ? "Change snooze"
                    : "Snooze"}
                </button>
                <span>Observed {ago(detail.item.observedAt)}</span>
              </div>
              {confirmSnooze && (
                <div className="snooze-options">
                  {[
                    { label: "1 hour", hours: 1 },
                    { label: "Tomorrow", hours: 24 },
                    { label: "Next week", hours: 168 },
                  ].map((o) => (
                    <button
                      disabled={busy}
                      key={o.label}
                      onClick={() =>
                        void local(
                          {
                            snoozedUntil: new Date(
                              Date.now() + o.hours * 3600000,
                            ).toISOString(),
                          },
                          "Item snoozed.",
                        )
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void local({ snoozedUntil: "" }, "Returned to attention.")
                    }
                  >
                    Return now
                  </button>
                </div>
              )}
              {detail.detailError && (
                <div className="notice">
                  <AlertTriangle size={16} />
                  <span>{detail.detailError} Showing cached context.</span>
                </div>
              )}
            </div>
            <div className="detail-tabs" aria-label="Detail views">
              {["Context", "Activity", "Private note", "Update"].map((t) => (
                <button
                  key={t}
                  aria-pressed={tab === t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="detail-body">
              {tab === "Context" && (
                <>
                  {SOURCES.filter(
                    (s) =>
                      s !== detail.item.source ||
                      detail.related.some((r) => r.source === s),
                  ).map((s) => {
                    const rows = detail.related.filter((r) => r.source === s);
                    return (
                      <section className="context-group" key={s}>
                        <h2>
                          <SourceLabel source={s} />
                          <small>{rows.length} related</small>
                        </h2>
                        {rows.length ? (
                          rows.map((r) => {
                            const link = detail.links.find(
                              (l) => l.from === r.id || l.to === r.id,
                            )!;
                            return (
                              <div className="related-item" key={r.id}>
                                <button
                                  className="related-open"
                                  onClick={() => open(r.id)}
                                >
                                  <span>
                                    <small>
                                      {r.source === "outlook" ? "Email" : r.key}
                                    </small>
                                    <strong>{r.title}</strong>
                                  </span>
                                  <ArrowUpRight size={17} />
                                </button>
                                <Status item={r} />
                                <p>{link.evidence}</p>
                                {link.state === "suggested" ? (
                                  <div className="suggestion-actions">
                                    <span className="badge warning">
                                      Suggested relationship
                                    </span>
                                    <button
                                      onClick={async () => {
                                        try {
                                          await api(
                                            "/links/" + link.id,
                                            "PATCH",
                                            { state: "confirmed" },
                                          );
                                          await load();
                                          await changed();
                                          notify("Relationship confirmed.");
                                        } catch (e) {
                                          setError((e as Error).message);
                                        }
                                      }}
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      onClick={async () => {
                                        try {
                                          await api(
                                            "/links/" + link.id,
                                            "PATCH",
                                            { state: "dismissed" },
                                          );
                                          await load();
                                          await changed();
                                        } catch (e) {
                                          setError((e as Error).message);
                                        }
                                      }}
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                ) : (
                                  <small className="verified">
                                    <Check size={13} />
                                    {link.state === "confirmed"
                                      ? "Confirmed by you"
                                      : "Explicit reference"}
                                  </small>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <p className="no-related">
                            No related{" "}
                            {s === "gitlab"
                              ? "merge requests"
                              : s === "outlook"
                                ? "email"
                                : s === "jira"
                                  ? "tickets"
                                  : "incidents"}{" "}
                            in the current collection.
                          </p>
                        )}
                      </section>
                    );
                  })}
                </>
              )}
              {tab === "Activity" && (
                <>
                  <h2 className="section-heading">Source comments</h2>
                  {detail.comments.length ? (
                    detail.comments.map((c) => (
                      <article className="comment" key={c.id}>
                        <div>
                          <strong>{c.author || "Unknown author"}</strong>
                          <time>{fmt(c.created)}</time>
                        </div>
                        <p>{c.body}</p>
                      </article>
                    ))
                  ) : (
                    <p className="muted">
                      No comments in this source snapshot.
                    </p>
                  )}
                  <h2 className="section-heading spaced">Workspace activity</h2>
                  <ActivityList rows={detail.activity} />
                </>
              )}
              {tab === "Private note" && (
                <>
                  <h2 className="section-heading">
                    A place for your next step
                  </h2>
                  <p className="muted">
                    Stored locally. This note is never sent to a source service.
                  </p>
                  <label htmlFor="private-note">Private working note</label>
                  <textarea
                    id="private-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={9}
                    placeholder="What do you want to remember?"
                  />
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void local({ note }, "Private note saved.")}
                  >
                    <Check size={15} />
                    Save note
                  </button>
                </>
              )}
              {tab === "Update" && (
                <>
                  {proposal ? (
                    <ProposalReview
                      proposal={proposal}
                      busy={busy}
                      mode={mode}
                      execute={execute}
                      cancel={async () => {
                        if (proposal.state === "pending")
                          await api(
                            "/proposals/" + proposal.id + "/reject",
                            "POST",
                            {},
                          );
                        setProposal(undefined);
                        await changed();
                      }}
                    />
                  ) : detail.item.source === "jira" ||
                    detail.item.source === "servicenow" ? (
                    <>
                      <h2 className="section-heading">
                        {detail.item.source === "jira"
                          ? "Update this ticket"
                          : "Add an incident work note"}
                      </h2>
                      <p className="muted">
                        Review the exact update before sending it
                        {mode === "demo"
                          ? " to the demo collection"
                          : ` to ${names[detail.item.source]}`}
                        .
                      </p>
                      {detail.item.source === "jira" && (
                        <div className="transition-form">
                          <label htmlFor="transition">
                            Available transition
                          </label>
                          <div>
                            <select
                              id="transition"
                              value={transition}
                              onChange={(e) => setTransition(e.target.value)}
                            >
                              <option value="">Choose a transition…</option>
                              {detail.transitions.map((t) => (
                                <option key={t.id} value={t.name}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="button"
                              disabled={!transition || busy}
                              onClick={() =>
                                void propose("transition", transition)
                              }
                            >
                              Review change
                            </button>
                          </div>
                        </div>
                      )}
                      <label htmlFor="update-body">
                        {detail.item.source === "jira"
                          ? "Comment"
                          : "Work note"}
                      </label>
                      <textarea
                        id="update-body"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={6}
                        placeholder="Write the update you want to share…"
                      />
                      <button
                        className="button primary"
                        disabled={!body.trim() || busy}
                        onClick={() =>
                          void propose(
                            detail.item.source === "jira" ? "comment" : "note",
                            body,
                          )
                        }
                      >
                        Review update <ArrowRight size={15} />
                      </button>
                    </>
                  ) : (
                    <Empty
                      icon={ArrowUpRight}
                      title="Continue in the source"
                      text="Merge request and email writes are not available in this first release. Read the connected context here and use the source link to act."
                    />
                  )}
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
function ProposalReview({
  proposal: p,
  busy,
  mode,
  execute,
  cancel,
}: {
  proposal: Proposal;
  busy: boolean;
  mode: string;
  execute: () => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const [actionError, setActionError] = useState("");
  async function cancelSafely() {
    try {
      await cancel();
    } catch (error) {
      setActionError((error as Error).message);
    }
  }
  return (
    <div className="proposal-review">
      {actionError && (
        <div className="alert" role="alert">
          {actionError}
        </div>
      )}
      <h2>Review {p.action === "transition" ? "status change" : "update"}</h2>
      <p className="muted">
        {mode === "demo"
          ? "This changes demo data only."
          : "This will send an update to the source service."}
      </p>
      <div className="proposal-body">{p.body}</div>
      <small>
        Prepared by {p.actor} · {fmt(p.createdAt)}
      </small>
      {p.state === "pending" ? (
        <>
          <p className="review-note">
            <ShieldCheck size={17} />
            The source is checked again before this update is sent.
          </p>
          <div className="action-row">
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void execute()}
            >
              {busy
                ? "Sending…"
                : mode === "demo"
                  ? "Apply to demo"
                  : "Confirm and send"}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void cancelSafely()}
            >
              Cancel proposal
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={`notice ${p.state === "succeeded" ? "success" : ""}`}>
            {p.state}: {p.result}
          </div>
          <button className="button" onClick={() => void cancelSafely()}>
            Back to update
          </button>
        </>
      )}
    </div>
  );
}
function ActivityList({ rows }: { rows: Activity[] }) {
  return rows.length ? (
    <div className="activity-list">
      {rows.map((a) => (
        <article key={a.id}>
          <span className="activity-node" />
          <div>
            <strong>{a.title}</strong>
            <p>{a.detail}</p>
            <small>
              {a.actor} · {fmt(a.at)}
            </small>
          </div>
        </article>
      ))}
    </div>
  ) : (
    <p className="muted">No workspace activity yet.</p>
  );
}
function ActivityView({ mode }: { mode: string }) {
  const [rows, setRows] = useState<Activity[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Activity[]>("/activity")
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [mode]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Every action, accounted for.</h1>
          <p>Notes, decisions and source updates in one local history.</p>
        </div>
      </div>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      <div className="activity-page">
        <ActivityList rows={rows} />
      </div>
    </>
  );
}
function AgentDesk({
  snapshot,
  reload,
  notify,
  open,
}: {
  snapshot: Snapshot;
  reload: () => Promise<void>;
  notify: (s: string) => void;
  open: (id: string) => void;
}) {
  const [review, setReview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = snapshot.proposals.filter((p) => p.state === "pending");
  const reviewed = snapshot.proposals.filter((p) => p.state !== "pending");
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Keep work moving.</h1>
          <p>Agents gather context. You make the consequential calls.</p>
        </div>
        <span className="badge">
          <ShieldCheck size={13} />
          Review before sending
        </span>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <div className="agent-layout">
        <section>
          <div className="list-caption">
            <h2>Waiting on you</h2>
            <span>{pending.length} open</span>
          </div>
          {pending.length ? (
            pending.map((p) => {
              const i = snapshot.items.find((i) => i.id === p.itemId);
              return (
                <article className="agent-proposal" key={p.id}>
                  <div className="row-meta">
                    <span className="badge warning">Approval required</span>
                    {i && <SourceLabel source={i.source} />}
                  </div>
                  <h2>
                    {p.action === "transition"
                      ? `Move ${i?.key} to ${p.body}`
                      : `An update for ${i?.key || p.itemId}`}
                  </h2>
                  <p className="muted">
                    Prepared by {p.actor} · {fmt(p.createdAt)}
                  </p>
                  {review === p.id ? (
                    <ProposalReview
                      proposal={p}
                      busy={busy}
                      mode={snapshot.mode}
                      execute={async () => {
                        setBusy(true);
                        try {
                          const r = await api<Proposal>(
                            "/proposals/" + p.id + "/execute",
                            "POST",
                            {},
                          );
                          await reload();
                          setReview(undefined);
                          notify(r.result);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      cancel={async () => {
                        await api("/proposals/" + p.id + "/reject", "POST", {});
                        await reload();
                        setReview(undefined);
                      }}
                    />
                  ) : (
                    <>
                      <div className="proposal-body">{p.body}</div>
                      <div className="action-row">
                        <button
                          className="button primary"
                          onClick={() => setReview(p.id)}
                        >
                          Review proposal <ArrowRight size={15} />
                        </button>
                        <button
                          className="button"
                          onClick={() => open(p.itemId)}
                        >
                          Open context
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })
          ) : (
            <Empty
              icon={ShieldCheck}
              title="No decisions waiting"
              text="Agents can read shared context and submit proposals through the Workroom API or CLI."
            />
          )}
        </section>
        <aside className="agent-aside">
          <h2>Shared context for your agents</h2>
          <p>
            The agent CLI reads the same records and relationships you see here.
            Proposals appear in this queue before any update is sent.
          </p>
          <code>npm run agent -- list</code>
          <code>npm run agent -- show ITEM_ID</code>
          <h2 className="spaced">Recent outcomes</h2>
          {reviewed.length ? (
            reviewed.slice(0, 6).map((p) => (
              <div className="outcome" key={p.id}>
                <span
                  className={`badge ${p.state === "uncertain" || p.state === "failed" ? "warning" : ""}`}
                >
                  {p.state}
                </span>
                <p>{p.result}</p>
              </div>
            ))
          ) : (
            <p>No proposals reviewed yet.</p>
          )}
        </aside>
      </div>
    </>
  );
}
function Connections({
  settings,
  snapshot,
  refresh,
  refreshing,
  save,
}: {
  settings?: Settings;
  snapshot: Snapshot;
  refresh: (s?: Source) => Promise<void>;
  refreshing: boolean;
  save: (s: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setDraft(settings), [settings]);
  if (!draft)
    return <div className="loading">Loading connection settings…</div>;
  function update(s: Source, key: string, value: unknown) {
    setDraft((d) =>
      d
        ? {
            ...d,
            connectors: {
              ...d.connectors,
              [s]: { ...d.connectors[s], [key]: value },
            },
          }
        : d,
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Your tools, together.</h1>
          <p>Use the CLIs already authenticated on this work machine.</p>
        </div>
        <button
          className="button primary"
          disabled={saving || refreshing}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await save(draft);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save connections"}
        </button>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <div className="settings-intro">
        <div>
          <h2>Collection</h2>
          <p>
            Demo and live data are stored separately. Switching collections
            preserves your notes in each.
          </p>
        </div>
        <div className="segmented">
          <button
            className={draft.mode === "demo" ? "active" : ""}
            onClick={() => setDraft({ ...draft, mode: "demo" })}
          >
            Demo
          </button>
          <button
            className={draft.mode === "live" ? "active" : ""}
            onClick={() => setDraft({ ...draft, mode: "live" })}
          >
            Live
          </button>
        </div>
        <label className="refresh-setting">
          Refresh every{" "}
          <select
            value={draft.refreshMinutes}
            onChange={(e) =>
              setDraft({ ...draft, refreshMinutes: Number(e.target.value) })
            }
          >
            {[1, 5, 10, 15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="notice">
        <ShieldCheck size={17} />
        <span>
          Credentials stay with your CLIs. Enable sources and save, then
          refresh. Live actions always require review in this interface.
        </span>
      </div>
      <div className="connection-settings">
        {SOURCES.map((s) => {
          const c = draft.connectors[s];
          const state = snapshot.connectors.find((x) => x.source === s)!;
          return (
            <section className="connector" key={s}>
              <div className="connector-heading">
                <div>
                  <Logo source={s} size={30} />
                  <h2>{names[s]}</h2>
                  <code>{c.executable}</code>
                </div>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={(e) => update(s, "enabled", e.target.checked)}
                  />
                  Enable live connector
                </label>
              </div>
              <div className="connector-fields">
                {s !== "gitlab" && (
                  <label>
                    CLI profile
                    <input
                      value={c.profile}
                      onChange={(e) => update(s, "profile", e.target.value)}
                      placeholder="Active CLI profile"
                    />
                  </label>
                )}
                {s === "gitlab" ? (
                  <label className="wide">
                    Repositories{" "}
                    <small>
                      One host/group/project or group/project per line
                    </small>
                    <textarea
                      rows={3}
                      value={c.repositories.join("\n")}
                      onChange={(e) =>
                        update(s, "repositories", e.target.value.split("\n"))
                      }
                      onBlur={() =>
                        update(
                          s,
                          "repositories",
                          c.repositories.map((r) => r.trim()).filter(Boolean),
                        )
                      }
                      placeholder="gitlab.example.com/platform/payments"
                    />
                  </label>
                ) : (
                  <label className="wide">
                    {s === "jira"
                      ? "JQL"
                      : s === "servicenow"
                        ? "Incident encoded query"
                        : "Mail search (optional)"}
                    <input
                      value={c.query}
                      onChange={(e) => update(s, "query", e.target.value)}
                      placeholder={
                        s === "jira"
                          ? "Assigned to me, unfinished, newest first"
                          : s === "servicenow"
                            ? "Active incidents assigned to me or my groups"
                            : "Recent messages in the chosen folder"
                      }
                    />
                  </label>
                )}
                {s === "servicenow" && (
                  <label>
                    Instance URL <small>For source links</small>
                    <input
                      type="url"
                      value={c.baseUrl}
                      onChange={(e) => update(s, "baseUrl", e.target.value)}
                      placeholder="https://company.service-now.com"
                    />
                  </label>
                )}
                {s === "outlook" && (
                  <label>
                    Mail folder
                    <input
                      value={c.folder}
                      onChange={(e) => update(s, "folder", e.target.value)}
                      placeholder="inbox"
                    />
                  </label>
                )}
              </div>
              <div className="connector-status">
                <div>
                  {state.error ? (
                    <span className="danger">
                      <AlertTriangle size={14} />
                      {state.error}
                    </span>
                  ) : (
                    <span>
                      <span className="dot" />
                      {snapshot.mode === "demo"
                        ? "Demo collection"
                        : state.lastSuccess
                          ? `Last refreshed ${ago(state.lastSuccess)}`
                          : "Not yet refreshed"}
                    </span>
                  )}
                  <small>
                    {state.count || 0} records
                    {state.limited
                      ? " · Bounded snapshot: more records may exist upstream"
                      : ""}
                  </small>
                </div>
                <button
                  className="button"
                  disabled={
                    refreshing ||
                    saving ||
                    (!state.enabled && snapshot.mode === "live")
                  }
                  onClick={() => void refresh(s)}
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <RepositorySettings
        value={draft.development}
        onChange={(development) => setDraft({ ...draft, development })}
      />
      <p className="settings-footnote">
        Collection is currently capped at 100 items per source (100 MRs per
        repository). Narrow your queries to keep attention relevant. Executable
        paths can be changed in workroom.config.json and take effect after
        restarting the app.
      </p>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
