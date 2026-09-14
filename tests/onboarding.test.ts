import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import { Onboarding } from "../server/onboarding.js";
import type { ToolRunner } from "../server/tool-process.js";
import type { Runner } from "../server/adapters.js";
const cli: Runner = async (_exe, args) =>
  args.includes("myself")
    ? { accountId: "fixture-account" }
    : {
        items: [
          {
            key: "TEST-1",
            summary: "Fixture issue",
            status: "To Do",
            updated: "2026-09-14T09:00:00Z",
          },
        ],
        total: 1,
      };
const tools: ToolRunner = async (_exe, args) =>
  args.includes("--help")
    ? "--output search mr auth incidents mail --plugin-dir --session-id --resume"
    : "tool 1.2.3";
function fixture(run = tools, source = cli) {
  const store = new Store(":memory:");
  const service = new Service(store, source, "/no-setup-config");
  const setup = new Onboarding(service, run, "darwin", () => false, source);
  return { store, service, setup };
}
test("setup choices persist without changing live settings or selecting an agent by default", () => {
  const f = fixture();
  try {
    const initial = f.setup.state();
    assert.deepEqual(initial.agents, []);
    const next = f.setup.save({
      ...initial,
      step: 2,
      services: ["jira"],
      agents: ["codex", "cline"],
      dismissed: true,
    }).state;
    assert.equal(f.service.mode, "demo");
    assert.equal(f.service.settings.connectors.jira.enabled, false);
    const restored = new Onboarding(f.service).state();
    assert.deepEqual(restored, next);
    assert.throws(() => f.setup.save(initial), /another window/);
    assert.throws(
      () =>
        f.setup.save({
          ...next,
          configs: {
            ...next.configs,
            jira: { ...next.configs.jira, executable: "/tmp/other" },
          },
        }),
      /executable paths/,
    );
  } finally {
    f.store.close();
  }
});
test("tool checks distinguish missing and incompatible CLIs and do not expose raw output", async () => {
  const calls: string[][] = [];
  const f = fixture(async (exe, args) => {
    calls.push([exe, ...args]);
    if (exe === "outlook")
      throw Object.assign(new Error("private diagnostic"), { code: "ENOENT" });
    if (args.includes("--help"))
      return exe === "jira"
        ? "obsolete search"
        : "--output search mr auth incidents mail --plugin-dir --session-id --resume";
    return "version 1.2.3 private diagnostic";
  });
  try {
    const result = await f.setup.check();
    assert.equal(
      result.checks.find((c) => c.id === "outlook")?.state,
      "missing",
    );
    assert.equal(
      result.checks.find((c) => c.id === "jira")?.state,
      "incompatible",
    );
    assert.ok(!JSON.stringify(result).includes("private diagnostic"));
    assert.ok(calls.every((c) => c[1] === "--version" || c[1] === "--help"));
  } finally {
    f.store.close();
  }
});
test("verified connection enables the live inbox; changed drafts require verification again", async () => {
  const f = fixture();
  try {
    f.setup.save({
      ...f.setup.state(),
      services: ["jira", "outlook"],
      agents: ["codex"],
    });
    let result = await f.setup.verify("jira");
    assert.equal(result.connections[0].state, "ready");
    const changed = {
      ...result.state,
      configs: {
        ...result.state.configs,
        jira: { ...result.state.configs.jira, query: "project = NEXT" },
      },
    };
    f.setup.save(changed);
    await assert.rejects(
      () => f.setup.finish(f.setup.state().version),
      /Verify at least one/,
    );
    await f.setup.verify("jira");
    const snapshot = await f.setup.finish(f.setup.state().version);
    assert.equal(snapshot.mode, "live");
    assert.equal(snapshot.items[0].key, "TEST-1");
    assert.deepEqual(f.service.settings.agents?.enabled, ["codex"]);
    assert.equal(f.service.settings.connectors.outlook.enabled, false);
    assert.ok(f.setup.state().completedAt);
  } finally {
    f.store.close();
  }
});
test("anonymous empty Jira search cannot become a verified connection", async () => {
  let searched = false;
  const f = fixture(tools, async (_exe, args) => {
    if (args.includes("search")) searched = true;
    return {};
  });
  try {
    const result = await f.setup.verify("jira");
    assert.equal(result.connections[0].state, "error");
    assert.equal(searched, false);
    assert.equal(f.service.mode, "demo");
  } finally {
    f.store.close();
  }
});
test("connection verification cannot approve a draft edited while its request is running", async () => {
  let release!: (x: any) => void;
  const f = fixture(
    tools,
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  try {
    const pending = f.setup.verify("outlook");
    const s = f.setup.state();
    f.setup.save({
      ...s,
      configs: {
        ...s.configs,
        outlook: { ...s.configs.outlook, folder: "changed" },
      },
    });
    release({ items: [] });
    await assert.rejects(() => pending, /changed during verification/);
    assert.equal(f.setup.overview().connections.length, 0);
  } finally {
    f.store.close();
  }
});
test("installations require explicit confirmation and fixed platform-compatible commands", async () => {
  const calls: string[][] = [];
  let release!: (x: string) => void;
  const f = fixture(async (exe, args, _timeout, onSpawn) => {
    calls.push([exe, ...args]);
    if (args.includes("install")) {
      onSpawn?.(222);
      return new Promise((r) => {
        release = r;
      });
    }
    return "1.2.3";
  });
  try {
    await assert.rejects(() =>
      f.setup.install({ tool: "jira", installer: "uv" }),
    );
    await assert.rejects(() =>
      f.setup.install({
        tool: "jira",
        installer: "uv",
        confirmed: true,
        args: ["malicious"],
      }),
    );
    await assert.rejects(() =>
      f.setup.install({ tool: "jira", installer: "shell", confirmed: true }),
    );
    const result = await f.setup.install({
      tool: "jira",
      installer: "uv",
      confirmed: true,
    });
    assert.equal(result.job?.state, "running");
    assert.deepEqual(calls.at(-1), [
      "uv",
      "tool",
      "install",
      "--no-build",
      "jira-cli-rs",
    ]);
    await assert.rejects(
      () =>
        f.setup.install({ tool: "cline", installer: "npm", confirmed: true }),
      /still running/,
    );
    release("");
    await new Promise((r) => setImmediate(r));
    assert.equal(f.setup.overview().job?.state, "succeeded");
  } finally {
    f.store.close();
  }
});
test("a restarted installation is never replayed while its recorded process remains present", async () => {
  const f = fixture();
  try {
    f.store.set("setup:install", {
      id: "fixture",
      tool: "jira",
      installer: "uv",
      command: "uv tool install --no-build jira-cli-rs",
      state: "running",
      startedAt: new Date().toISOString(),
      detail: "",
      pid: 222,
    });
    let called = false;
    const restored = new Onboarding(
      f.service,
      async () => {
        called = true;
        return "";
      },
      "darwin",
      () => true,
    );
    assert.equal(restored.overview().job?.state, "interrupted");
    await assert.rejects(
      () =>
        restored.install({ tool: "jira", installer: "uv", confirmed: true }),
      /still running/,
    );
    assert.equal(called, false);
  } finally {
    f.store.close();
  }
});

test("completion rejects a stale review and a repository check never creates a branch", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { git } = await import("../server/git.js");
  const root = mkdtempSync(join(tmpdir(), "workroom-setup-repo-"));
  const f = fixture();
  try {
    await git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "test.txt"), "fixture\n");
    await git(root, ["add", "test.txt"]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "test: fixture",
    ]);
    const state = f.setup.state();
    f.setup.save({
      ...state,
      services: ["jira"],
      development: {
        repositories: [
          {
            id: "test",
            name: "Test",
            path: root,
            project: "example.invalid/group/project",
            baseBranch: "main",
          },
        ],
        teamMembers: [],
      },
    });
    await f.setup.verify("jira");
    await assert.rejects(
      () => f.setup.finish(state.version),
      /changed after review/,
    );
    const before = await git(root, ["for-each-ref", "--format=%(refname)"]);
    const result = await f.setup.repository("test");
    assert.match(result.baseSha, /^[a-f0-9]{40}$/);
    assert.equal(
      await git(root, ["for-each-ref", "--format=%(refname)"]),
      before,
    );
    assert.equal(await git(root, ["status", "--porcelain"]), "");
  } finally {
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed installer diagnostics do not expose output or automatically retry", async () => {
  const f = fixture(async (_exe, args) => {
    if (args.includes("install")) throw new Error("private-install-output");
    return "1.2.3";
  });
  try {
    await f.setup.install({ tool: "cline", installer: "npm", confirmed: true });
    await new Promise((r) => setImmediate(r));
    const result = f.setup.overview();
    assert.equal(result.job?.state, "failed");
    assert.equal(
      JSON.stringify(result).includes("private-install-output"),
      false,
    );
  } finally {
    f.store.close();
  }
});
