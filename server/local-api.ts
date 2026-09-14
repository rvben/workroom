import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fingerprint } from "./outbox.js";
import type { EventInput } from "../shared/events.js";
import type { AdapterDelivery } from "../shared/terminal.js";
export function localClient(
  dataDir: string,
  url: string,
  leaseToken = "",
  reportToken = "",
) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Workroom requires a plain loopback HTTP origin.");
  const base = parsed.origin;
  const token = readFileSync(resolve(dataDir, "agent-token"), "utf8").trim();
  const api = async <T = any>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Workroom-Lease": leaseToken,
        "X-Workroom-Report": reportToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    const result = await res.json();
    if (!res.ok)
      throw new Error(result.error || `Workroom returned ${res.status}`);
    return result;
  };
  const deliver = (
    sessionId: string,
    event: EventInput,
    delivery?: AdapterDelivery,
  ) =>
    delivery
      ? api(`/api/terminal/${encodeURIComponent(delivery.runId)}/events`, {
          nativeSessionId: delivery.nativeSessionId,
          hook: delivery.hook,
          event,
        })
      : api(
          `/api/work/sessions/${encodeURIComponent(sessionId)}/events`,
          event,
        );
  return { api, deliver, target: fingerprint(base + "\n" + token), base };
}
