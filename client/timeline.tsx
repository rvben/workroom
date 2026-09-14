import { useEffect, useRef, useState } from "react";
import { Clock3, RefreshCw, FileCheck2 } from "lucide-react";
import { api } from "./api";
import type { EventPage, WorkEvent } from "../shared/events";

const date = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
function evidenceLink(reference: string) {
  try {
    const u = new URL(reference);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function WorkTimeline({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [older, setOlder] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const [order, setOrder] = useState("received");
  const active = useRef(true);
  const loading = useRef(false);
  const newest = useRef(0);
  const initialized = useRef(false);
  async function load(before?: number) {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    try {
      const initial = !initialized.current;
      const query =
        before !== undefined || initial
          ? `before=${before ?? Number.MAX_SAFE_INTEGER}`
          : `after=${newest.current}`;
      const page = await api<EventPage>(
        `/work/sessions/${encodeURIComponent(sessionId)}/events?${query}&limit=100`,
      );
      if (!active.current) return;
      setEvents((previous) => [
        ...new Map(
          [...previous, ...page.events].map((e) => [e.id, e]),
        ).values(),
      ]);
      newest.current = Math.max(
        newest.current,
        ...page.events.map((e) => e.sequence),
      );
      if (initial || before !== undefined)
        setOlder(page.hasMore ? page.nextCursor : null);
      initialized.current = true;
      setLoaded(true);
      setError("");
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      loading.current = false;
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [sessionId]);
  const sorted = [...events].sort((a, b) =>
    order === "occurred"
      ? b.occurredAt.localeCompare(a.occurredAt) || b.sequence - a.sequence
      : b.sequence - a.sequence,
  );
  const last = [...events]
    .sort((a, b) => b.sequence - a.sequence)
    .find((e) => e.source === "agent" || e.kind === "report");
  return (
    <section className="work-timeline" aria-label="Work timeline">
      <div className="timeline-heading">
        <div>
          <h3>
            <Clock3 size={18} /> Work timeline
          </h3>
          <p>
            Reports only ·{" "}
            {last
              ? `Last received ${date(last.receivedAt)}`
              : "No progress reports in loaded history"}
          </p>
        </div>
        <button
          className="button"
          disabled={busy}
          onClick={() => void load()}
          aria-label="Refresh work timeline"
        >
          <RefreshCw size={15} />
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      <p className="timeline-caption">
        Reports record what was shared. Terminal activity and queued reports are
        not automatically visible.
      </p>
      {error && (
        <p className="alert" role="alert">
          Timeline could not refresh: {error} Your last loaded history remains
          below. Use Refresh to retry.
        </p>
      )}
      {!loaded && !error && <p role="status">Loading work history…</p>}
      {loaded && !events.length && (
        <div className="timeline-empty">
          <FileCheck2 size={22} />
          <div>
            <strong>The next update starts the record.</strong>
            <p>
              Ask your agent to report findings, decisions, test evidence and
              blockers through the Workroom CLI. Earlier activity has not been
              backfilled.
            </p>
          </div>
        </div>
      )}
      {!!events.length && (
        <>
          <label className="timeline-order">
            Newest first, by{" "}
            <select
              value={order}
              onChange={(e) => setOrder(e.target.value)}
              aria-label="Timeline time order"
            >
              <option value="received">time received</option>
              <option value="occurred">reported occurrence</option>
            </select>
          </label>
          <ol className="timeline-events">
            {sorted.slice(0, visibleCount).map((e) => {
              const delayed =
                Date.parse(e.receivedAt) - Date.parse(e.occurredAt) > 60000;
              return (
                <li key={e.id} id={`event-${e.id}`}>
                  <div className="timeline-meta">
                    <span>
                      {e.actor} ·{" "}
                      {e.source === "agent"
                        ? "Agent-reported"
                        : "Workroom record"}
                    </span>
                    <time dateTime={e.occurredAt}>
                      Occurred {date(e.occurredAt)}
                    </time>
                  </div>
                  <h4>{e.summary}</h4>
                  <div className="timeline-tags">
                    <span>{e.kind}</span>
                    {e.historical && <span>Past ownership · history only</span>}
                    {delayed && <span>Received later</span>}
                  </div>
                  {e.detail &&
                    (e.kind === "report" ? (
                      <details>
                        <summary>Full progress snapshot</summary>
                        <p className="preserve-text">{e.detail}</p>
                      </details>
                    ) : (
                      <p className="preserve-text">{e.detail}</p>
                    ))}
                  {!!e.evidence.length && (
                    <ul className="timeline-evidence">
                      {e.evidence.map((v, i) => {
                        const href =
                          v.kind === "link" ? evidenceLink(v.reference) : null;
                        return (
                          <li key={i}>
                            <strong>{v.label}</strong>
                            <span>{v.kind} reference · supplied by agent</span>
                            {href ? (
                              <a href={href} target="_blank" rel="noreferrer">
                                {v.reference}
                              </a>
                            ) : (
                              <code>{v.reference}</code>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <details>
                    <summary>Provenance & delivery</summary>
                    <dl>
                      <dt>
                        Occurred{" "}
                        {e.source === "agent"
                          ? "(agent clock)"
                          : "(Workroom clock)"}
                      </dt>
                      <dd>{date(e.occurredAt)}</dd>
                      <dt>Received</dt>
                      <dd>{date(e.receivedAt)}</dd>
                      <dt>Event</dt>
                      <dd>{e.id}</dd>
                      <dt>Reporting attempt</dt>
                      <dd>{e.attemptId || "No agent attempt"}</dd>
                      <dt>Native conversation</dt>
                      <dd>
                        {e.conversation
                          ? `${e.conversation.agent} · ${e.conversation.id} (reported identity)`
                          : "Not linked"}
                      </dd>
                      {e.corrects && (
                        <>
                          <dt>Corrects event</dt>
                          <dd>{e.corrects} · original preserved</dd>
                        </>
                      )}
                    </dl>
                  </details>
                </li>
              );
            })}
          </ol>
          {(sorted.length > visibleCount || older !== null) && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setVisibleCount((n) => n + 10);
                if (sorted.length <= visibleCount && older !== null)
                  void load(older);
              }}
            >
              Show more history
            </button>
          )}
        </>
      )}
    </section>
  );
}
