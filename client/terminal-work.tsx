import { useEffect, useState } from "react";
import { Terminal, Copy } from "lucide-react";
import { api } from "./api";
import type { TerminalRun } from "../shared/terminal";
import type { WorkSession } from "../shared/types";
export function TerminalWork({
  session,
  mode,
}: {
  session: WorkSession;
  mode: string;
}) {
  const [agent, setAgent] = useState(""),
    [runs, setRuns] = useState<TerminalRun[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setRuns(await api(`/work/sessions/${session.id}/terminal`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const rows = await api<TerminalRun[]>(
          `/work/sessions/${session.id}/terminal`,
        );
        if (active) {
          setRuns(rows);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [session.id]);
  const command = `npm run agent -- terminal start ${session.id} --agent ${agent}`;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(
        "Command copied. Run it from your Workroom installation on the work machine.",
      );
    } catch {
      setError("Clipboard unavailable. Select and copy the command.");
    }
  }
  const blocked =
    mode !== "live" ||
    session.owner !== "agent" ||
    runs.some((r) => r.state !== "stopped");
  return (
    <section className="terminal-work" aria-label="Continue in terminal">
      <h3>
        <Terminal size={18} /> Continue in terminal
      </h3>
      <p>
        Start an interactive agent with this worktree and context. Native hooks
        report milestones while you keep the conversation in your terminal.
      </p>
      {mode === "demo" ? (
        <p className="timeline-caption">
          Demo cannot launch agents. Configure a real repository and start a
          live work session.
        </p>
      ) : session.owner !== "agent" ? (
        <p>Hand this session to an agent below before starting or resuming.</p>
      ) : null}
      <label>
        Agent adapter
        <select
          aria-label="Terminal agent adapter"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">Choose an agent</option>
          <option value="claude">Claude Code · native hooks</option>
        </select>
      </label>
      <p className="timeline-caption">
        Codex and Cline can use manual CLI reporting today. Their native
        adapters are not implemented yet.
      </p>
      {agent && <code className="terminal-command">{command}</code>}
      <button
        className="button primary"
        disabled={!agent || blocked}
        onClick={() => void copy(command)}
      >
        <Copy size={14} /> Copy start command
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {runs.map((r) => (
        <div className="terminal-run" key={r.id}>
          <div className="timeline-meta">
            <strong>
              Claude Code · {r.state}
              {r.exitCode ? ` · exit ${r.exitCode}` : ""}
            </strong>
            <span>
              {r.hookConnected
                ? "Native session observed"
                : "Awaiting native hook"}
            </span>
          </div>
          <code>{r.nativeSessionId}</code>
          <p>{r.note}</p>
          <small>
            Last wrapper contact: {new Date(r.lastSeenAt).toLocaleString()}
            {Date.now() - Date.parse(r.lastSeenAt) > 120000 &&
            r.state !== "stopped"
              ? " · connection stale; process state needs checking"
              : ""}
          </small>
          <small>
            {r.lastHookAt
              ? `Last native hook: ${new Date(r.lastHookAt).toLocaleString()}`
              : "No native hook received"}
          </small>
          {r.state === "stopped" && r.hookConnected ? (
            <button
              className="button"
              disabled={blocked}
              onClick={() =>
                void copy(
                  `npm run agent -- terminal start ${session.id} --agent claude --resume ${r.nativeSessionId}`,
                )
              }
            >
              Copy resume command · same conversation
            </button>
          ) : r.state !== "stopped" ? (
            <button
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/terminal/${r.id}/reconcile`, "POST", {});
                  await load();
                  setNotice(
                    "Recorded processes are absent. This execution attempt is now stopped.",
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check whether execution has stopped
            </button>
          ) : null}
        </div>
      ))}
      <p className="timeline-caption">
        Exit the native CLI before switching interfaces. Resume restores the
        recorded native ID; it does not start a new conversation. Processes
        started outside this wrapper are not controlled by Workroom.
      </p>
    </section>
  );
}
