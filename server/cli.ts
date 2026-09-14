import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eventSchema } from "../shared/events.js";
import { Outbox, fingerprint } from "./outbox.js";
import { resolve } from "node:path";
const [command, ...args] = process.argv.slice(2);
const usage = `Workroom agent CLI\n  sessions | session ID | packet ID\n  claim ID AGENT [CONVERSATION_JSON_FILE] | heartbeat ID\n  report ID JSON_FILE | handoff ID JSON_FILE\n  event ID JSON_FILE | events ID [AFTER_CURSOR]\n  outbox [show ID | hold ID REASON | release ID | rebind SESSION_ID ATTEMPT_ID] | flush [--watch]\n  Events use WORKROOM_ATTEMPT_ID and WORKROOM_REPORT_TOKEN from claim.\n  Set WORKROOM_LEASE_TOKEN to the returned claim token.\n  npm run agent -- list\n  npm run agent -- show ITEM_ID\n  npm run agent -- sync\n  npm run agent -- propose ITEM_ID comment|transition|note BODY\n\nReads the same context as the UI. Proposals require human review in Workroom.`;
if (!command || command === "help") {
  console.log(usage);
  process.exit(0);
}
const base = process.env.WORKROOM_URL || "http://127.0.0.1:4310";
const u = new URL(base);
if (!["localhost", "127.0.0.1"].includes(u.hostname) || u.protocol !== "http:")
  throw new Error(
    "This CLI only sends the local token to a loopback Workroom server.",
  );
const token = readFileSync(
  resolve(process.env.WORKROOM_DATA_DIR || ".data", "agent-token"),
  "utf8",
).trim();
async function api(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Workroom-Lease": process.env.WORKROOM_LEASE_TOKEN || "",
      "X-Workroom-Report": process.env.WORKROOM_REPORT_TOKEN || "",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data.error);
  return data;
}
try {
  let result;
  if (["event", "outbox", "flush"].includes(command)) {
    const outbox = new Outbox(
      resolve(process.env.WORKROOM_DATA_DIR || ".data", "agent-outbox.sqlite"),
    );
    try {
      if (command === "outbox") {
        if (!args.length) result = outbox.status();
        else if (args[0] === "rebind" && args.length === 3) {
          if (!process.env.WORKROOM_REPORT_TOKEN)
            throw new Error("Set the replacement WORKROOM_REPORT_TOKEN first.");
          await api(
            `/api/work/sessions/${encodeURIComponent(args[1])}/reporting/${encodeURIComponent(args[2])}/verify`,
            {},
          );
          result = outbox.rebind(
            fingerprint(base + "\n" + token),
            args[1],
            args[2],
            fingerprint(process.env.WORKROOM_REPORT_TOKEN),
          );
        } else if (args[0] === "show" && args.length === 2)
          result = outbox.inspect(args[1]);
        else if (args[0] === "hold" && args.length === 3)
          result = outbox.hold(args[1], args[2]);
        else if (args[0] === "release" && args.length === 2)
          result = outbox.release(args[1]);
        else
          throw new Error(
            "Usage: outbox [show EVENT_ID | hold EVENT_ID REASON | release EVENT_ID]",
          );
      } else {
        const reportToken = process.env.WORKROOM_REPORT_TOKEN;
        if (!reportToken)
          throw new Error(
            "Set WORKROOM_REPORT_TOKEN from the original claim. No reporting credential is stored in the outbox.",
          );
        const target = fingerprint(base + "\n" + token);
        const credential = fingerprint(reportToken);
        if (command === "event") {
          if (!args[0] || !args[1])
            throw new Error("Usage: event SESSION_ID JSON_FILE");
          const input = JSON.parse(readFileSync(args[1], "utf8"));
          const event = eventSchema.parse({
            ...input,
            id: input.id ?? randomUUID(),
            attemptId: input.attemptId ?? process.env.WORKROOM_ATTEMPT_ID,
            occurredAt: input.occurredAt ?? new Date().toISOString(),
          });
          outbox.enqueue(target, credential, args[0], event);
          result = {
            eventId: event.id,
            ...(await outbox.flush(target, credential, (id, e) =>
              api(
                "/api/work/sessions/" + encodeURIComponent(id) + "/events",
                e,
              ),
            )),
          };
        } else {
          if (args.length > 1 || (args[0] && args[0] !== "--watch"))
            throw new Error("Usage: flush [--watch]");
          let stopped = false;
          const stop = () => {
            stopped = true;
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          try {
            do {
              result = await outbox.flush(target, credential, (id, e) =>
                api(
                  "/api/work/sessions/" + encodeURIComponent(id) + "/events",
                  e,
                ),
              );
              if (args[0] !== "--watch") {
                if (result.matchingRemaining) process.exitCode = 1;
                break;
              }
              console.log(
                JSON.stringify({ at: new Date().toISOString(), ...result }),
              );
              for (let i = 0; i < 10 && !stopped; i++)
                await new Promise((r) => setTimeout(r, 1000));
            } while (!stopped);
          } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
          }
        }
      }
    } finally {
      outbox.close();
    }
  } else if (command === "events" && args[0]) {
    const after = Number(args[1] ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("AFTER_CURSOR must be a nonnegative integer.");
    result = await api(
      "/api/work/sessions/" +
        encodeURIComponent(args[0]) +
        "/events?after=" +
        after,
    );
  } else if (command === "list") result = await api("/api/snapshot");
  else if (command === "show" && args[0])
    result = await api("/api/items/" + encodeURIComponent(args[0]));
  else if (command === "sessions") result = await api("/api/work/sessions");
  else if (
    ["session", "packet", "claim", "heartbeat", "report", "handoff"].includes(
      command,
    ) &&
    args[0]
  ) {
    const path = "/api/work/sessions/" + encodeURIComponent(args[0]);
    if (command === "session") result = await api(path);
    else if (command === "packet") result = await api(path + "/packet");
    else if (command === "claim")
      result = await api(path + "/claim", {
        agent: args[1] || "Agent",
        ...(args[2]
          ? { conversation: JSON.parse(readFileSync(args[2], "utf8")) }
          : {}),
      });
    else if (command === "heartbeat")
      result = await api(path + "/heartbeat", {});
    else
      result = await api(
        path + "/" + command,
        JSON.parse(readFileSync(args[1], "utf8")),
      );
  } else if (command === "sync") result = await api("/api/sync", {});
  else if (command === "propose" && args.length === 3) {
    const detail = await api("/api/items/" + encodeURIComponent(args[0]));
    result = await api("/api/proposals", {
      itemId: args[0],
      action: args[1],
      body: args[2],
      expectedUpdatedAt: detail.item.updatedAt,
      actor: "Agent CLI",
    });
  } else throw new Error(usage);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
