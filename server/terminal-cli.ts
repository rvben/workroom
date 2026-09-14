import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { localClient } from "./local-api.js";
import { Outbox, fingerprint } from "./outbox.js";
import { claudeArgs, claudeHooks, shellQuote } from "./claude-adapter.js";
import {
  readBinding,
  writeBinding,
  type TerminalBinding,
} from "./terminal-binding.js";
import { processExists } from "./terminal-sessions.js";
import { eventSchema } from "../shared/events.js";
import type { TerminalRun } from "../shared/terminal.js";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "terminal start SESSION_ID --agent claude [--resume NATIVE_ID] [--prompt FILE] [--executable PATH]\nterminal runs SESSION_ID | reconcile RUN_ID | recover RUN_ID | milestone RUN_ID EVENT_FILE | report RUN_ID REPORT_FILE | handoff RUN_ID HANDOFF_FILE";
export function parseTerminalStart(args: string[]) {
  if (!args[0] || args[0].startsWith("--")) throw new Error(usage);
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !["--agent", "--resume", "--prompt", "--executable"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options[key]
    )
      throw new Error(usage);
    options[key] = value;
  }
  if (options["--agent"] !== "claude")
    throw new Error(
      "Choose an implemented adapter explicitly with --agent claude. No agent is selected by default.",
    );
  if (options["--resume"]) z.uuid().parse(options["--resume"]);
  return {
    sessionId: args[0],
    agent: "claude" as const,
    resume: options["--resume"],
    promptFile: options["--prompt"],
    executable: options["--executable"] || "claude",
  };
}
export async function terminalCommand(args: string[]) {
  const dataDir = resolve(process.env.WORKROOM_DATA_DIR || ".data"),
    url = process.env.WORKROOM_URL || "http://127.0.0.1:4310";
  const client = localClient(dataDir, url);
  const pathFor = (id: string) =>
    resolve(dataDir, "terminal", z.uuid().parse(id) + ".json");
  if (args[0] === "runs" && args.length === 2)
    return client.api(
      `/api/work/sessions/${encodeURIComponent(args[1])}/terminal`,
    );
  if (args[0] === "reconcile" && args.length === 2)
    return client.api(
      `/api/terminal/${encodeURIComponent(args[1])}/reconcile`,
      {},
    );
  if (["recover", "milestone", "report", "handoff"].includes(args[0])) {
    if (args.length !== (args[0] === "recover" ? 2 : 3)) throw new Error(usage);
    const file = pathFor(args[1]),
      b = readBinding(file);
    if (client.target !== b.target)
      throw new Error(
        "This run belongs to a different Workroom server or server credential.",
      );
    const outbox = new Outbox(resolve(dataDir, "agent-outbox.sqlite"));
    try {
      if (args[0] === "recover") {
        if (processExists(b.wrapperPid) && b.state !== "stopped")
          throw new Error(
            "Stop the terminal wrapper before replacing its credential.",
          );
        const replacement = process.env.WORKROOM_REPORT_TOKEN;
        if (!replacement)
          throw new Error(
            "Set WORKROOM_REPORT_TOKEN to the replacement from Workroom.",
          );
        await localClient(dataDir, url, "", replacement).api(
          `/api/work/sessions/${b.sessionId}/reporting/${b.attemptId}/verify`,
          {},
        );
        b.reportingToken = replacement;
        writeBinding(file, b);
        return outbox.rebind(
          client.target,
          b.sessionId,
          b.attemptId,
          fingerprint(replacement),
        );
      }
      const raw = JSON.parse(readFileSync(args[2], "utf8"));
      if (args[0] === "report" || args[0] === "handoff") {
        const active = localClient(
          dataDir,
          url,
          b.leaseToken,
          b.reportingToken,
        );
        const current = await active.api(`/api/work/sessions/${b.sessionId}`);
        return active.api(`/api/work/sessions/${b.sessionId}/${args[0]}`, {
          ...raw,
          version: raw.version ?? current.version,
          ...(args[0] === "handoff" ? { to: raw.to ?? "human" } : {}),
        });
      }
      if (raw.attemptId && raw.attemptId !== b.attemptId)
        throw new Error("Milestone belongs to another attempt.");
      const event = eventSchema.parse({
        ...raw,
        id: raw.id ?? randomUUID(),
        occurredAt: raw.occurredAt ?? new Date().toISOString(),
        attemptId: b.attemptId,
      });
      outbox.enqueue(
        b.target,
        fingerprint(b.reportingToken),
        b.sessionId,
        event,
      );
      return {
        eventId: event.id,
        ...(await outbox.flush(
          b.target,
          fingerprint(b.reportingToken),
          localClient(dataDir, url, b.leaseToken, b.reportingToken).deliver,
        )),
      };
    } finally {
      outbox.close();
    }
  }
  if (args[0] !== "start") throw new Error(usage);
  if (process.platform === "win32")
    throw new Error(
      "The terminal process-group adapter currently supports macOS and Linux.",
    );
  const options = parseTerminalStart(args.slice(1));
  const { stdout: help } = await exec(options.executable, ["--help"], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  for (const flag of ["--plugin-dir", "--session-id", "--resume"])
    if (!help.includes(flag))
      throw new Error(
        `Installed agent does not advertise ${flag}. Update it before starting.`,
      );
  const packet = await client.api(
    `/api/work/sessions/${encodeURIComponent(options.sessionId)}/packet`,
  );
  if (!existsSync(packet.session.worktree))
    throw new Error(
      "The recorded worktree does not exist. Demo sessions cannot launch agents.",
    );
  const worktree = realpathSync(packet.session.worktree);
  const branch = (
    await exec("git", ["branch", "--show-current"], {
      cwd: worktree,
      timeout: 10000,
    })
  ).stdout.trim();
  if (branch !== packet.session.branch)
    throw new Error(
      "The worktree branch changed. Restore the recorded branch before starting the agent.",
    );
  const configDir = resolve(
    process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"),
  );
  if (options.resume) {
    const previous = (
      await client.api<TerminalRun[]>(
        `/api/work/sessions/${encodeURIComponent(options.sessionId)}/terminal`,
      )
    ).find((r) => r.nativeSessionId === options.resume);
    if (!previous || !existsSync(pathFor(previous.id)))
      throw new Error(
        "The local continuation binding is unavailable; inspect the original terminal before resuming.",
      );
    const prior = readBinding(pathFor(previous.id));
    if (
      prior.configDir !== configDir ||
      prior.worktree !== worktree ||
      prior.target !== client.target
    )
      throw new Error(
        "Resume requires the same agent configuration directory, worktree and Workroom server.",
      );
  }
  const prompt = options.promptFile
    ? readFileSync(resolve(options.promptFile), "utf8")
    : options.resume
      ? undefined
      : `Work on the linked Workroom session. Objective: ${packet.session.objective}. Read the captured context packet and follow the reporting instructions supplied by the Workroom hook.`;
  if (prompt && prompt.length > 30000)
    throw new Error("Keep the initial prompt under 30,000 characters.");
  const started = await client.api(
    `/api/work/sessions/${encodeURIComponent(options.sessionId)}/terminal`,
    {
      agent: options.agent,
      wrapperPid: process.pid,
      ...(options.resume ? { resume: options.resume } : {}),
    },
  );
  const b: TerminalBinding = {
    ...started.run,
    dataDir,
    url: client.base,
    target: client.target,
    leaseToken: started.leaseToken,
    reportingToken: started.reportingToken,
    root,
    executable: options.executable,
    configDir,
    packetPath: resolve(dataDir, "terminal", started.run.id, "packet.json"),
  };
  return runTerminal(b, packet, Boolean(options.resume), prompt);
}
export async function runTerminal(
  b: TerminalBinding,
  packet: unknown,
  resume: boolean,
  prompt?: string,
) {
  const path = resolve(b.dataDir, "terminal", b.id + ".json"),
    dir = resolve(b.dataDir, "terminal", b.id),
    plugin = resolve(dir, "plugin");
  const client = localClient(b.dataDir, b.url, b.leaseToken, b.reportingToken);
  let outbox: Outbox | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false,
    busy = false,
    lastBeat = 0,
    lastError = "";
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onTerm = () => {
    stopping = true;
    signalGroup("SIGTERM");
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      if (child?.exitCode === null && child.signalCode === null)
        signalGroup("SIGKILL");
    }, 2000);
    killTimer.unref();
  };
  const onInt = () => {
    signalGroup("SIGINT");
  };
  const flush = async () =>
    outbox!.flush(b.target, fingerprint(b.reportingToken), client.deliver);
  try {
    mkdirSync(resolve(plugin, ".claude-plugin"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(resolve(plugin, "hooks"), { recursive: true, mode: 0o700 });
    writeBinding(path, b);
    writeFileSync(b.packetPath, JSON.stringify(packet), { mode: 0o600 });
    writeFileSync(
      resolve(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({
        name: "workroom-reporting",
        version: "0.1.0",
        description: "Workroom terminal milestones and ownership checks",
      }),
      { mode: 0o600 },
    );
    const command = [
      process.execPath,
      resolve(root, "node_modules/tsx/dist/cli.mjs"),
      resolve(root, "server/claude-hook.ts"),
      path,
    ]
      .map(shellQuote)
      .join(" ");
    writeFileSync(
      resolve(plugin, "hooks/hooks.json"),
      JSON.stringify(claudeHooks(command)),
      { mode: 0o600 },
    );
    outbox = new Outbox(resolve(b.dataDir, "agent-outbox.sqlite"));
    console.error(
      `Workroom: native conversation ${b.nativeSessionId}\nRun ${b.id}. Exit the native CLI normally to release this execution attempt.\nResume later: npm run agent -- terminal start ${b.sessionId} --agent claude --resume ${b.nativeSessionId}`,
    );
    child = spawn(
      b.executable,
      claudeArgs(plugin, b.nativeSessionId, resume, prompt),
      {
        cwd: b.worktree,
        stdio: "inherit",
        detached: true,
        env: {
          ...process.env,
          ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: b.configDir } : {}),
          WORKROOM_ROOT: b.root,
          WORKROOM_DATA_DIR: b.dataDir,
          WORKROOM_URL: b.url,
          WORKROOM_SESSION_ID: b.sessionId,
          WORKROOM_ATTEMPT_ID: b.attemptId,
          WORKROOM_LEASE_TOKEN: b.leaseToken,
          WORKROOM_REPORT_TOKEN: b.reportingToken,
        },
      },
    );
    const done = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // Observe failures immediately even if process registration is still in flight.
    void done.catch(() => {});
    if (!child.pid) throw new Error("Native CLI could not be started.");
    b.childPid = child.pid;
    b.state = "running";
    writeBinding(path, b);
    await client.api(`/api/terminal/${b.id}/running`, { childPid: child.pid });
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    timer = setInterval(() => {
      if (busy || stopping) return;
      busy = true;
      void (async () => {
        try {
          if (Date.now() - lastBeat > 60000) {
            await client.api(`/api/terminal/${b.id}/heartbeat`, {});
            lastBeat = Date.now();
          }
          const result = await flush();
          if (result.error && result.error !== lastError) {
            console.error("Workroom reporting queued: " + result.error);
            lastError = result.error;
          }
        } catch (e) {
          console.error(
            "Workroom ownership could not be renewed. Stopping the managed process; queued reports are retained.",
          );
          onTerm();
        } finally {
          busy = false;
        }
      })();
    }, 3000);
    const result = await done;
    clearInterval(timer);
    timer = undefined;
    while (busy) await new Promise((r) => setTimeout(r, 50));
    const pending = await flush();
    if (pending.remaining)
      console.error(
        `${pending.remaining} events remain in the local outbox. Use the original reporting environment or credential recovery to deliver them.`,
      );
    const finished = await client.api<TerminalRun>(
      `/api/terminal/${b.id}/finish`,
      { exitCode: result.code },
    );
    Object.assign(b, finished);
    writeBinding(path, b);
    if (result.code) process.exitCode = result.code;
    if (result.signal) process.exitCode = 130;
    return { run: finished, pendingEvents: pending.remaining };
  } catch (e) {
    stopping = true;
    signalGroup("SIGTERM");
    if (child?.pid) {
      await new Promise((r) => setTimeout(r, 300));
      if (processExists(-child.pid)) {
        signalGroup("SIGKILL");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      const finished = await client.api<TerminalRun>(
        `/api/terminal/${b.id}/finish`,
        { exitCode: null },
      );
      Object.assign(b, finished);
    } catch {
      b.state = "unknown";
    }
    if (existsSync(dir)) writeBinding(path, b);
    throw e;
  } finally {
    if (timer) clearInterval(timer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    while (busy) await new Promise((r) => setTimeout(r, 50));
    outbox?.close();
  }
}
