import { useState } from "react";
import { api } from "./api";
import type { ReportingAccess } from "../shared/events";
export function ReportingCredentials({ sessionId }: { sessionId: string }) {
  const [access, setAccess] = useState<ReportingAccess[]>([]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [secret, setSecret] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      setAccess(await api(`/work/sessions/${sessionId}/reporting`));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function manage(a: ReportingAccess, action: "rotate" | "revoke") {
    setBusy(true);
    setError("");
    setSecret("");
    setNotice("");
    try {
      const result = await api<{ reportingToken?: string }>(
        `/work/sessions/${sessionId}/reporting/${a.id}/${action}`,
        "POST",
        { credentialVersion: a.credentialVersion },
      );
      setSecret(result.reportingToken || "");
      setNotice(
        action === "rotate"
          ? "Replacement created. Copy it now; it will not be shown again. The previous credential is invalid."
          : "Reporting revoked. Existing events and work ownership are unchanged.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="reporting-access"
      onToggle={(e) => {
        if (e.currentTarget.open && !loaded && !busy) void load();
      }}
    >
      <summary>Reporting access & recovery</summary>
      <p>
        Control which attempts can append history, including after a handoff.
        These controls do not stop agents or revoke their work lease.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {secret && (
        <div className="credential-recovery">
          <label>
            Replacement reporting token
            <input type="password" value={secret} readOnly autoComplete="off" />
          </label>
          <button
            className="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret);
                setNotice(
                  "Replacement token copied. Set WORKROOM_REPORT_TOKEN in the original terminal, then rebind its queue.",
                );
              } catch {
                setError(
                  "Clipboard unavailable. Select and copy the token field.",
                );
              }
            }}
          >
            Copy replacement token
          </button>
          <button className="button" onClick={() => setSecret("")}>
            Hide token
          </button>
        </div>
      )}
      {loaded && !access.length && (
        <p>No reporting credentials yet. Claiming work creates one.</p>
      )}
      {access.map((a) => (
        <div className="reporting-access-row" key={a.id}>
          <strong>
            {a.actor} · {a.status}
          </strong>
          <small>
            {new Date(a.createdAt).toLocaleString()} ·{" "}
            {a.conversation
              ? `${a.conversation.agent} / ${a.conversation.id}`
              : "No native conversation linked"}
          </small>
          <code>{a.id}</code>
          <div className="dev-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => void manage(a, "rotate")}
            >
              {a.status === "revoked"
                ? "Restore with new token"
                : "Replace token"}
            </button>
            <button
              className="button"
              disabled={busy || a.status === "revoked"}
              onClick={() => void manage(a, "revoke")}
            >
              Revoke reporting
            </button>
          </div>
        </div>
      ))}
      <button className="button" disabled={busy} onClick={() => void load()}>
        {busy ? "Loading…" : "Refresh reporting access"}
      </button>
      <p>
        After replacement, set the new <code>WORKROOM_REPORT_TOKEN</code> in the
        reporting shell and run:
      </p>
      <code className="recovery-command">
        npm run agent -- outbox rebind {sessionId} ATTEMPT_ID
      </code>
      <p>
        Then run <code>npm run agent -- flush</code>. Pending events retain
        their IDs, times and content.
      </p>
    </details>
  );
}
