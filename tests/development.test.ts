import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import { Sessions } from "../server/sessions.js";
import { git } from "../server/git.js";
import { normalize } from "../server/normalize.js";
import { mrSignals } from "../shared/mrs.js";
function fixture() {
  const store = new Store(":memory:");
  const service = new Service(store, undefined, "/nonexistent-config");
  const sessions = new Sessions(service);
  const item = store
    .items("demo")
    .find((i) => i.source === "jira" && !i.closed)!;
  return { store, service, sessions, item };
}
async function start(
  f: ReturnType<typeof fixture>,
  owner: "human" | "agent" = "human",
) {
  const plan = await f.sessions.plan({
    itemId: f.item.id,
    repositoryId: "demo-payments",
    branch: "APP-1/fix",
    owner,
    objective: "Fix retries",
    acceptance: "Recovery is tested",
  });
  return f.sessions.start(plan);
}
test("sessions preserve ownership, reject stale progress and revoke agent leases on handoff", async () => {
  const f = fixture();
  try {
    let s = await start(f, "agent");
    const c = f.sessions.claim(s.id, "worker");
    assert.throws(() => f.sessions.claim(s.id, "other"), /Already claimed/);
    assert.throws(
      () =>
        f.sessions.report(
          s.id,
          { version: c.session.version, summary: "overwrite" },
          "",
          true,
        ),
      /Take over/,
    );
    s = f.sessions.report(
      s.id,
      {
        version: c.session.version,
        summary: "Implemented",
        tests: "Unit tests passed",
        state: "review",
      },
      c.leaseToken,
      false,
    );
    assert.throws(
      () =>
        f.sessions.report(
          s.id,
          { version: c.session.version },
          c.leaseToken,
          false,
        ),
      /changed/,
    );
    s = f.sessions.handoff(
      s.id,
      s.version,
      "human",
      "Ready for review",
      c.leaseToken,
      false,
    );
    assert.throws(() => f.sessions.heartbeat(s.id, c.leaseToken), /lease/);
    assert.equal(s.owner, "human");
    assert.equal(s.handoffs.length, 1);
    s = f.sessions.report(
      s.id,
      { version: s.version, state: "completed" },
      "",
      true,
    );
    assert.equal(s.state, "completed");
    assert.throws(
      () => f.sessions.handoff(s.id, s.version, "agent", "again", "", true),
      /not available/,
    );
  } finally {
    f.store.db.close();
  }
});
test("agent completion and expiry cannot revive old leases", async () => {
  const f = fixture();
  try {
    const s = await start(f, "agent");
    const c = f.sessions.claim(s.id, "worker");
    f.sessions.report(
      s.id,
      {
        version: c.session.version,
        state: "completed",
        summary: "Done",
        tests: "Passed",
      },
      c.leaseToken,
      false,
    );
    assert.throws(() => f.sessions.heartbeat(s.id, c.leaseToken), /lease/);
  } finally {
    f.store.db.close();
  }
});
test("one active session per issue; demo publication is reviewed and not replayable", async () => {
  const f = fixture();
  try {
    const s = await start(f);
    assert.equal((await start(f)).id, s.id);
    const prepared = await f.sessions.preparePublish(
      s.id,
      "Fix retries",
      "Tests passed",
    );
    assert.equal(prepared.publication?.state, "prepared");
    assert.equal(
      (await f.sessions.publish(s.id, prepared.version)).publication?.state,
      "published",
    );
    await assert.rejects(
      () => f.sessions.publish(s.id, prepared.version),
      /review/,
    );
  } finally {
    f.store.db.close();
  }
});
test("local worktree creation leaves the original checkout and dirty files untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "workroom-git-"));
  const f = fixture();
  try {
    await git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "test: initial fixture",
    ]);
    writeFileSync(join(root, "tracked.txt"), "uncommitted\n");
    f.service.mode = "live";
    f.service.settings.mode = "live";
    f.service.settings.development = {
      repositories: [
        {
          id: "local",
          name: "Local",
          path: root,
          project: "example.invalid/group/project",
          baseBranch: "main",
        },
      ],
      teamMembers: [],
    };
    f.store.upsert("live", f.item);
    const sessions = new Sessions(f.service, join(root, "trees"));
    const request = {
      itemId: f.item.id,
      repositoryId: "local",
      branch: "APP-1/recovery",
      owner: "human",
      objective: "Fix recovery",
      acceptance: "Test recovery",
    };
    const plan = await sessions.plan(request);
    assert.ok(plan.warnings.some((w) => w.includes("changes")));
    await assert.rejects(
      () => sessions.start({ ...plan, baseSha: "stale" }),
      /base commit/,
    );
    await assert.rejects(
      () => sessions.plan({ ...request, branch: "--evil" }),
      /valid feature/,
    );
    const s = await sessions.start(plan);
    assert.equal(s.state, "ready");
    assert.equal(
      readFileSync(join(root, "tracked.txt"), "utf8"),
      "uncommitted\n",
    );
    assert.equal(
      readFileSync(join(s.worktree, "tracked.txt"), "utf8"),
      "base\n",
    );
    assert.equal(await git(root, ["branch", "--show-current"]), "main");
    assert.equal(
      await git(s.worktree, ["branch", "--show-current"]),
      "APP-1/recovery",
    );
  } finally {
    f.store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("MR ownership uses authenticated identity and never infers unknown checks passed", () => {
  const item = normalize("gitlab", {
    iid: 1,
    project_id: 1,
    title: "Fix",
    state: "opened",
    author: { id: 1, username: "me" },
    reviewers: [{ id: 2 }],
    _viewer: { id: 2, username: "reviewer" },
  });
  const s = mrSignals(item);
  assert.equal(s.mine, false);
  assert.equal(s.reviewRequested, true);
  assert.equal(s.approved, null);
  assert.equal(s.pipeline, "unknown");
  assert.equal(s.score, 70);
  assert.equal(
    mrSignals({ ...item, raw: { ...item.raw, _viewer: null } }).score,
    0,
  );
});

test("publication rejects changed HEAD before push and locks concurrent session updates", async () => {
  const f = fixture();
  try {
    let s = await start(f);
    f.service.mode = "live";
    f.service.settings.mode = "live";
    f.store.insertSession("live", s);
    s.publication = {
      state: "prepared",
      sha: "reviewed",
      title: "Draft: Fix",
      description: "Fix",
      remote: "https://gitlab.com/group/project",
      url: "",
      error: "",
    };
    f.sessions.save("live", s);
    const calls: string[][] = [];
    let release!: (x: string) => void;
    const sessions = new Sessions(f.service, "/unused", async (_cwd, args) => {
      calls.push(args);
      return new Promise<string>((r) => {
        release = r;
      });
    });
    const pending = sessions.publish(s.id, s.version);
    assert.throws(
      () => sessions.handoff(s.id, s.version + 1, "agent", "Next", "", true),
      /publication/,
    );
    await assert.rejects(() => sessions.publish(s.id, s.version), /review/);
    release("changed");
    const result = await pending;
    assert.equal(result.publication?.state, "failed");
    assert.equal(
      calls.some((c) => c[0] === "push"),
      false,
    );
  } finally {
    f.store.db.close();
  }
});

test("ambiguous remote push is not automatically replayed", async () => {
  const f = fixture();
  try {
    let s = await start(f);
    f.service.mode = "live";
    f.service.settings.mode = "live";
    f.store.insertSession("live", s);
    s.publication = {
      state: "prepared",
      sha: "reviewed",
      title: "Draft: Fix",
      description: "Fix",
      remote: "https://gitlab.com/group/project",
      url: "",
      error: "",
    };
    f.sessions.save("live", s);
    let pushes = 0;
    const sessions = new Sessions(f.service, "/unused", async (_cwd, args) => {
      if (args[0] === "rev-parse") return "reviewed";
      if (args[0] === "remote") return s.publication!.remote;
      if (args[0] === "symbolic-ref") return s.branch;
      if (args[0] === "push") {
        pushes++;
        throw new Error("Connection lost");
      }
      throw new Error("Unexpected call");
    });
    const result = await sessions.publish(s.id, s.version);
    assert.equal(result.publication?.state, "uncertain");
    await assert.rejects(
      () => sessions.publish(s.id, result.version),
      /review/,
    );
    assert.equal(pushes, 1);
  } finally {
    f.store.db.close();
  }
});

test("identical project and MR numbers on different hosts remain separate", () => {
  const raw = { iid: 1, project_id: 2, title: "MR", state: "opened" };
  assert.notEqual(
    normalize("gitlab", { ...raw, _host: "one.example" }).id,
    normalize("gitlab", { ...raw, _host: "two.example" }).id,
  );
});
