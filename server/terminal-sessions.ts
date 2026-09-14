import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { Sessions } from "./sessions.js";
import type { TerminalRun } from "../shared/terminal.js";
export function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
const startSchema = z
  .object({
    agent: z.literal("claude"),
    wrapperPid: z.number().int().min(2),
    resume: z.uuid().optional(),
  })
  .strict();
export class TerminalSessions {
  constructor(
    private sessions: Sessions,
    private alive = processExists,
  ) {}
  get store() {
    return this.sessions.store;
  }
  get mode() {
    return this.sessions.mode;
  }
  list(id: string) {
    this.sessions.get(id);
    return this.store.terminalRuns(this.mode).filter((r) => r.sessionId === id);
  }
  get(id: string) {
    const run = this.store.terminalRun(this.mode, id);
    if (!run) throw new Error("Terminal run not found.");
    return run;
  }
  start(id: string, input: unknown) {
    const x = startSchema.parse(input),
      s = this.sessions.get(id);
    if (this.mode !== "live")
      throw new Error(
        "Terminal agents require a live session with a real worktree. Demo does not launch processes.",
      );
    const worktree = realpathSync(s.worktree);
    if (
      this.store
        .terminalRuns(this.mode)
        .some((r) => r.worktree === worktree && r.state !== "stopped")
    )
      throw new Error("This worktree has an unresolved terminal run.");
    if (x.resume) {
      const previous = this.list(id).find(
        (r) => r.agent === x.agent && r.nativeSessionId === x.resume,
      );
      if (!previous || previous.state !== "stopped" || !previous.hookConnected)
        throw new Error(
          "Resume requires a stopped, previously observed conversation for this work session.",
        );
    }
    const nativeSessionId = x.resume ?? randomUUID();
    const claim = this.sessions.claim(id, "Claude Code terminal", {
      agent: x.agent,
      id: nativeSessionId,
    });
    const now = new Date().toISOString();
    const run: TerminalRun = {
      id: randomUUID(),
      sessionId: id,
      attemptId: claim.attemptId,
      agent: x.agent,
      nativeSessionId,
      worktree,
      state: "launching",
      wrapperPid: x.wrapperPid,
      startedAt: now,
      lastSeenAt: now,
      hookConnected: false,
      note: "Waiting for the terminal wrapper and native session hook.",
    };
    this.store.saveTerminalRun(this.mode, run);
    return { run, ...claim };
  }
  authorize(run: TerminalRun, token: string) {
    const s = this.sessions.get(run.sessionId);
    this.sessions.checkLease(s, token);
    const a = this.store.attemptForLease(
      this.mode,
      s.id,
      this.store.claimHash(this.mode, s.id),
    );
    if (a?.id !== run.attemptId || run.state === "stopped")
      throw new Error("This terminal attempt no longer controls the work.");
    return s;
  }
  running(id: string, token: string, childPid: number) {
    const run = this.get(id);
    this.authorize(run, token);
    if (run.state !== "launching")
      throw new Error("Terminal process is already registered.");
    if (!Number.isInteger(childPid) || childPid < 2)
      throw new Error("Invalid child process ID.");
    run.childPid = childPid;
    run.state = "running";
    run.lastSeenAt = new Date().toISOString();
    run.note = "Terminal process registered; waiting for hook observations.";
    this.store.saveTerminalRun(this.mode, run);
    return run;
  }
  check(id: string, token: string) {
    const run = this.get(id);
    this.authorize(run, token);
    return run;
  }
  heartbeat(id: string, token: string) {
    const run = this.check(id, token);
    this.sessions.heartbeat(run.sessionId, token);
    run.lastSeenAt = new Date().toISOString();
    this.store.saveTerminalRun(this.mode, run);
    return run;
  }
  finish(id: string, reportToken: string, code: number | null) {
    const run = this.get(id);
    this.sessions.reportingAttempt(run.sessionId, run.attemptId, reportToken);
    if (run.state === "stopped") return run;
    // A child process group still present is not a verified stop. Never release its worktree lock.
    if (run.childPid && this.alive(-run.childPid)) {
      run.state = "unknown";
      run.note =
        "A process group is still present. Inspect the terminal before reconciling.";
      this.store.saveTerminalRun(this.mode, run);
      return run;
    }
    return this.stop(
      run,
      code,
      "Terminal wrapper reported exit; the recorded process group is absent.",
    );
  }
  reconcile(id: string) {
    const run = this.get(id);
    if (run.state === "stopped") return run;
    if (
      this.alive(run.wrapperPid) ||
      (run.childPid && this.alive(-run.childPid))
    )
      throw new Error(
        "The wrapper or recorded process group is still present. Stop it in its terminal first.",
      );
    return this.stop(
      run,
      null,
      "Reconciled after verifying the recorded wrapper and process group are absent. Inspect any detached jobs separately.",
    );
  }
  private stop(run: TerminalRun, code: number | null, note: string) {
    const s = this.sessions.get(run.sessionId),
      attempt = this.store.attempt(this.mode, run.attemptId)!;
    return this.store.transaction(() => {
      run.state = "stopped";
      run.exitCode = code;
      run.stoppedAt = new Date().toISOString();
      run.lastSeenAt = run.stoppedAt;
      run.note =
        code !== null && code !== 0
          ? `${note} Native CLI exited with status ${code}; inspect its terminal output before resuming.`
          : note;
      this.store.saveTerminalRun(this.mode, run);
      if (this.store.claimHash(this.mode, s.id) === attempt.leaseHash) {
        s.leaseOwner = "";
        s.leaseExpiresAt = "";
        this.sessions.save(this.mode, s, "");
      }
      this.sessions.record(
        s,
        "session",
        "Terminal execution stopped",
        note,
        "Workroom",
        run.attemptId,
      );
      return run;
    });
  }
  capture(id: string, input: unknown, token: string) {
    const x = z
      .object({
        nativeSessionId: z.uuid(),
        hook: z.enum([
          "SessionStart",
          "PostToolUse",
          "PostToolUseFailure",
          "Stop",
          "SessionEnd",
        ]),
        event: z.unknown(),
      })
      .strict()
      .parse(input);
    const run = this.get(id);
    if (x.nativeSessionId !== run.nativeSessionId)
      throw new Error(
        "Native conversation changed. Start a separate Workroom terminal run.",
      );
    const body = z
      .object({ attemptId: z.literal(run.attemptId) })
      .passthrough()
      .parse(x.event);
    const result = this.sessions.event(run.sessionId, body, token, "adapter");
    run.lastHookAt = new Date().toISOString();
    if (x.hook === "SessionStart") run.hookConnected = true;
    this.store.saveTerminalRun(this.mode, run);
    return result;
  }
}
