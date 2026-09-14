import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import { Sessions } from "../server/sessions.js";
import { TerminalSessions } from "../server/terminal-sessions.js";
import {
  mapClaudeHook,
  claudeArgs,
  claudeHooks,
} from "../server/claude-adapter.js";
import { parseTerminalStart } from "../server/terminal-cli.js";
import { Outbox } from "../server/outbox.js";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workroom-terminal-")),
    store = new Store(":memory:"),
    service = new Service(store, undefined, "/no-terminal-config"),
    sessions = new Sessions(service);
  const item = store
    .items("demo")
    .find((i) => i.source === "jira" && !i.closed)!;
  const s = await sessions.start(
    await sessions.plan({
      itemId: item.id,
      repositoryId: "demo-payments",
      branch: "test/terminal",
      owner: "agent",
      objective: "Test continuity",
      acceptance: "Same native ID on resume",
    }),
  );
  s.worktree = dir;
  store.insertSession("live", s);
  service.mode = "live";
  const alive = new Set<number>();
  const terminal = new TerminalSessions(sessions, (pid) => alive.has(pid));
  return {
    dir,
    store,
    service,
    sessions,
    s,
    alive,
    terminal,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("terminal restart preserves native identity, creates a new attempt, and blocks competing writers", async () => {
  const f = await fixture();
  try {
    const a = f.terminal.start(f.s.id, { agent: "claude", wrapperPid: 222 });
    assert.throws(
      () => f.terminal.start(f.s.id, { agent: "claude", wrapperPid: 333 }),
      /unresolved/,
    );
    const expired = f.sessions.get(f.s.id);
    expired.leaseExpiresAt = new Date(0).toISOString();
    f.sessions.save("live", expired);
    assert.throws(() => f.sessions.claim(f.s.id, "competing"), /terminal run/);
    expired.leaseExpiresAt = new Date(Date.now() + 60000).toISOString();
    f.sessions.save("live", expired);
    f.terminal.running(a.run.id, a.leaseToken, 223);
    const mapped = mapClaudeHook(a.run, {
      session_id: a.run.nativeSessionId,
      cwd: f.dir,
      hook_event_name: "SessionStart",
    })!;
    f.terminal.capture(
      a.run.id,
      {
        nativeSessionId: a.run.nativeSessionId,
        hook: mapped.delivery.hook,
        event: mapped.event,
      },
      a.reportingToken,
    );
    assert.equal(f.sessions.events(f.s.id).events.at(-1)?.source, "adapter");
    f.alive.add(-223);
    assert.equal(
      f.terminal.finish(a.run.id, a.reportingToken, 0).state,
      "unknown",
    );
    assert.throws(() => f.terminal.reconcile(a.run.id), /still present/);
    f.alive.clear();
    f.terminal.reconcile(a.run.id);
    assert.equal(f.sessions.get(f.s.id).leaseExpiresAt, "");
    const b = f.terminal.start(f.s.id, {
      agent: "claude",
      wrapperPid: 333,
      resume: a.run.nativeSessionId,
    });
    assert.equal(b.run.nativeSessionId, a.run.nativeSessionId);
    assert.notEqual(b.attemptId, a.attemptId);
    assert.throws(() => f.terminal.check(b.run.id, a.leaseToken), /lease/);
  } finally {
    f.close();
  }
});
test("unobserved conversations cannot resume and hook mismatch cannot be relabeled", async () => {
  const f = await fixture();
  try {
    const a = f.terminal.start(f.s.id, { agent: "claude", wrapperPid: 222 });
    assert.throws(
      () =>
        f.terminal.capture(
          a.run.id,
          { nativeSessionId: randomUUID(), hook: "SessionStart", event: {} },
          a.reportingToken,
        ),
      /conversation changed/,
    );
    f.terminal.finish(a.run.id, a.reportingToken, null);
    assert.throws(
      () =>
        f.terminal.start(f.s.id, {
          agent: "claude",
          wrapperPid: 333,
          resume: a.run.nativeSessionId,
        }),
      /previously observed/,
    );
  } finally {
    f.close();
  }
});
test("a terminal stop after human takeover cannot overwrite human ownership", async () => {
  const f = await fixture();
  try {
    const a = f.terminal.start(f.s.id, { agent: "claude", wrapperPid: 222 });
    const human = f.sessions.handoff(
      f.s.id,
      a.session.version,
      "human",
      "Inspect work",
      "",
      true,
    );
    assert.throws(() => f.terminal.check(a.run.id, a.leaseToken), /lease/);
    f.terminal.finish(a.run.id, a.reportingToken, 0);
    assert.deepEqual(f.sessions.get(f.s.id), human);
  } finally {
    f.close();
  }
});
test("hook capture excludes raw prompts, commands, output and external file paths", () => {
  const b = {
    id: randomUUID(),
    attemptId: randomUUID(),
    nativeSessionId: randomUUID(),
    worktree: "/work/repository",
  };
  const raw = {
    session_id: b.nativeSessionId,
    cwd: b.worktree,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_input: { command: "echo SYNTHETIC_SECRET" },
    tool_response: { stdout: "SYNTHETIC_SECRET" },
    prompt: "SYNTHETIC_SECRET",
  };
  const event = mapClaudeHook(b, raw)!;
  assert.equal(JSON.stringify(event).includes("SYNTHETIC_SECRET"), false);
  assert.equal(event.event.kind, "tool");
  assert.match(event.event.detail, /Test success is not inferred/);
  const external = mapClaudeHook(b, {
    ...raw,
    tool_name: "Write",
    tool_input: { file_path: "/outside/file" },
  })!;
  assert.equal(external.event.evidence.length, 0);
  const file = mapClaudeHook(b, {
    ...raw,
    tool_name: "Edit",
    tool_input: { file_path: "/work/repository/src/main.ts" },
  })!;
  assert.equal(file.event.evidence[0].reference, "src/main.ts");
  assert.throws(
    () => mapClaudeHook(b, { ...raw, session_id: randomUUID() }),
    /identity changed/,
  );
  assert.throws(() => mapClaudeHook(b, { ...raw, cwd: "/other" }), /outside/);
});
test("adapter choice is required and resume never requests a fork or permission bypass", () => {
  assert.throws(() => parseTerminalStart(["session"]), /explicitly/);
  assert.throws(
    () => parseTerminalStart(["session", "--agent", "codex"]),
    /explicitly/,
  );
  const id = randomUUID();
  assert.deepEqual(claudeArgs("/plugin", id, true), [
    "--plugin-dir",
    "/plugin",
    "--resume",
    id,
  ]);
  const hooks = claudeHooks("'node' 'hook'");
  assert.match(JSON.stringify(hooks), /PreToolUse/);
  assert.doesNotMatch(
    JSON.stringify(hooks),
    /bypass|permissionDecision.*allow/,
  );
});
test("duplicate native hook delivery retains one normalized event and native route metadata", async () => {
  const box = new Outbox(":memory:");
  try {
    const b = {
      id: randomUUID(),
      attemptId: randomUUID(),
      nativeSessionId: randomUUID(),
      worktree: "/work/repository",
    };
    const raw = {
      session_id: b.nativeSessionId,
      cwd: b.worktree,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_use_id: "call-1",
    };
    const a = mapClaudeHook(b, raw)!,
      next = mapClaudeHook(b, raw)!;
    const first = box.capture(a.key, a.event),
      duplicate = box.capture(next.key, next.event);
    assert.deepEqual(duplicate, first);
    box.enqueue("target", "credential", "session", first, a.delivery);
    box.enqueue("target", "credential", "session", duplicate, next.delivery);
    let calls = 0;
    await box.flush("target", "credential", async (_s, e, delivery) => {
      calls++;
      assert.equal(delivery?.runId, b.id);
      assert.equal(e.id, first.id);
    });
    assert.equal(calls, 1);
  } finally {
    box.close();
  }
});
