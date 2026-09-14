import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import {
  normalize,
  buildLinks,
  listPayload,
  safeUrl,
  mailText,
} from "../server/normalize.js";
import { Adapter, CliError } from "../server/adapters.js";
import type { Runner } from "../server/adapters.js";
const jira = (key = "APP-1", extra = {}) =>
  normalize("jira", {
    key,
    id: key,
    summary: "Payment retries fail",
    status: "In Progress",
    updated: "2026-09-14T09:00:00Z",
    ...extra,
  });
test("normalizes documented CLI envelopes, nullable fields and ServiceNow display values", () => {
  assert.equal(listPayload("jira", { items: [{}] }).length, 1);
  assert.equal(listPayload("servicenow", { result: [{}] }).length, 1);
  assert.throws(() => listPayload("jira", { error: "bad" }));
  const i = normalize("servicenow", {
    number: "INC1",
    sys_id: { value: "abc", display_value: "abc" },
    short_description: "Incident",
    priority: { value: "1", display_value: "1 - Critical" },
    state: { value: "2", display_value: "In Progress" },
    assigned_to: null,
  });
  assert.equal(i.id, "servicenow:abc");
  assert.equal(i.score, 100);
  assert.equal(i.assignee, "");
  assert.equal(i.closed, false);
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("https://user:secret@example.com"), "");
});
test("link matching respects ticket boundaries and distinguishes subject suggestions", () => {
  const root = jira();
  const exact = normalize("outlook", {
    id: "mail1",
    subject: "RE: APP-1 payment retry",
    isRead: false,
  });
  const wrong = normalize("outlook", {
    id: "mail2",
    subject: "APP-10 unrelated item",
    isRead: false,
  });
  const suggested = normalize("outlook", {
    id: "mail3",
    subject: "Payment retries rollout",
    isRead: false,
  });
  const links = buildLinks([root, exact, wrong, suggested]);
  assert.equal(links.length, 2);
  assert.equal(
    links.find((l) => l.to === exact.id || l.from === exact.id)?.state,
    "explicit",
  );
  assert.equal(
    links.find((l) => l.to === suggested.id || l.from === suggested.id)?.state,
    "suggested",
  );
});
test("local state persists across source refresh and reopening; demo and live are isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "workroom-test-"));
  try {
    let store = new Store(join(dir, "db.sqlite"));
    store.upsert("live", jira());
    store.local("live", "jira:APP-1", {
      note: "Remember the rollback",
      snoozedUntil: "2099-01-01T00:00:00Z",
    });
    store.replaceSource("live", "jira", [
      jira("APP-1", { summary: "Changed upstream" }),
    ]);
    assert.equal(
      store.item("live", "jira:APP-1")?.note,
      "Remember the rollback",
    );
    assert.equal(store.items("demo").length, 0);
    store.close();
    store = new Store(join(dir, "db.sqlite"));
    assert.equal(
      store.item("live", "jira:APP-1")?.snoozedUntil,
      "2099-01-01T00:00:00Z",
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("failed refresh keeps cached source data and reports its error", async () => {
  const store = new Store(":memory:");
  const service = new Service(
    store,
    async () => {
      throw new CliError("Auth expired.");
    },
    "/nonexistent",
  );
  service.mode = "live";
  service.settings.mode = "live";
  service.settings.connectors.jira.enabled = true;
  store.upsert("live", jira());
  await service.sync("jira");
  assert.equal(store.items("live").length, 1);
  assert.equal(
    service.states().find((s) => s.source === "jira")?.error,
    "Auth expired.",
  );
  store.close();
});
test("malformed collection does not clear cached records", async () => {
  const store = new Store(":memory:");
  const service = new Service(
    store,
    async () => ({ unexpected: true }),
    "/nonexistent",
  );
  service.mode = "live";
  service.settings.connectors.jira.enabled = true;
  store.upsert("live", jira());
  await service.sync("jira");
  assert.equal(store.items("live").length, 1);
  assert.match(service.states()[0].error || "", /format/);
  store.close();
});
test("adapter uses explicit JSON and argv arrays, never a shell command", async () => {
  let observed: string[] = [];
  const store = new Store(":memory:");
  const service = new Service(
    store,
    async (_exe, args) => {
      observed = args;
      return { items: [], total: 0 };
    },
    "/nonexistent",
  );
  const c = service.settings.connectors.jira;
  c.query = 'summary ~ "$(echo nope)"';
  await service.adapter("jira").collect();
  assert.ok(observed.includes(c.query));
  assert.deepEqual(
    observed.slice(
      observed.indexOf("--output"),
      observed.indexOf("--output") + 2,
    ),
    ["--output", "json"],
  );
  assert.ok(observed.includes("--limit"));
  store.close();
});
test("stale proposals fail before a remote write", async () => {
  let writes = 0;
  const runner: Runner = async (_exe, args, write) => {
    if (write) writes++;
    return {
      key: "APP-1",
      id: "1",
      summary: "changed",
      status: "In Progress",
      updated: "new-version",
    };
  };
  const store = new Store(":memory:");
  const service = new Service(store, runner, "/nonexistent");
  service.mode = "live";
  service.settings.connectors.jira.enabled = true;
  store.upsert("live", jira());
  const p = service.propose(
    "jira:APP-1",
    "comment",
    "A note",
    "Test",
    "2026-09-14T09:00:00Z",
  );
  const result = await service.execute(p.id);
  assert.equal(result.state, "failed");
  assert.equal(writes, 0);
  store.close();
});
test("uncertain writes are recorded and cannot be automatically replayed", async () => {
  let writes = 0;
  const runner: Runner = async (_exe, args, write) => {
    if (write) {
      writes++;
      throw new CliError("Timeout after sending", true);
    }
    return {
      key: "APP-1",
      id: "1",
      summary: "Payment retries fail",
      status: "In Progress",
      updated: "2026-09-14T09:00:00Z",
    };
  };
  const store = new Store(":memory:");
  const service = new Service(store, runner, "/nonexistent");
  service.mode = "live";
  service.settings.connectors.jira.enabled = true;
  store.upsert("live", jira());
  const p = service.propose(
    "jira:APP-1",
    "comment",
    "A note",
    "Test",
    "2026-09-14T09:00:00Z",
  );
  const result = await service.execute(p.id);
  assert.equal(result.state, "uncertain");
  await assert.rejects(() => service.execute(p.id));
  assert.equal(writes, 1);
  store.close();
});
test("demo transitions persist and do not invoke a CLI", async () => {
  const store = new Store(":memory:");
  const service = new Service(
    store,
    async () => {
      throw new Error("CLI must not run");
    },
    "/nonexistent",
  );
  const item = store.item("demo", "jira:PLAT-248")!;
  const p = service.propose(
    item.id,
    "transition",
    "Done",
    "You",
    item.updatedAt,
  );
  const result = await service.execute(p.id);
  assert.equal(result.state, "succeeded");
  assert.equal(store.item("demo", item.id)?.status, "Done");
  assert.equal(store.item("demo", item.id)?.closed, true);
  store.close();
});
test("confirmed and dismissed relationships survive re-collection", () => {
  const store = new Store(":memory:");
  const links = buildLinks([
    jira(),
    normalize("outlook", { id: "m", subject: "APP-1 update" }),
  ]);
  store.saveLink("live", { ...links[0], state: "dismissed" });
  store.reconcileLinks("live", links);
  assert.equal(store.links("live")[0].state, "dismissed");
  store.close();
});
test("explicit Jira links are found in both record directions", () => {
  const lower = jira("APP-1", {
    issueLinks: [{ outwardIssue: { key: "APP-2" } }],
  });
  const higher = jira("APP-2");
  assert.equal(buildLinks([lower, higher]).length, 1);
});
test("concurrent execution of one proposal produces only one write", async () => {
  let writes = 0;
  const store = new Store(":memory:");
  const service = new Service(
    store,
    async (_exe, _args, write) => {
      if (write) {
        writes++;
        return {};
      }
      return {
        key: "APP-1",
        summary: "Test",
        status: "In Progress",
        updated: "2026-09-14T09:00:00Z",
      };
    },
    "/nonexistent",
  );
  service.mode = "live";
  service.settings.connectors.jira.enabled = true;
  store.upsert("live", jira());
  const p = service.propose(
    "jira:APP-1",
    "comment",
    "once",
    "Test",
    "2026-09-14T09:00:00Z",
  );
  const results = await Promise.allSettled([
    service.execute(p.id),
    service.execute(p.id),
  ]);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(writes, 1);
  store.close();
});

test("email details show full body as text without remote markup", () => {
  assert.equal(
    mailText(
      { contentType: "text", content: "Full mail\nSecond paragraph" },
      "preview",
    ),
    "Full mail\nSecond paragraph",
  );
  assert.equal(
    mailText(
      {
        contentType: "html",
        content:
          '<style>secret</style><p>Hello &amp; team</p><p>Next step</p><img src="https://tracker.invalid/x">',
      },
      "preview",
    ),
    "Hello & team\nNext step",
  );
});

test("successful remote write stays successful when follow-up refresh fails", async () => {
  let reads = 0,
    writes = 0;
  const store = new Store(":memory:");
  const service = new Service(
    store,
    async (_exe, _args, write) => {
      if (write) {
        writes++;
        return {};
      }
      if (++reads > 1) throw new CliError("Refresh unavailable");
      return {
        key: "APP-1",
        summary: "Test",
        status: "In Progress",
        updated: "2026-09-14T09:00:00Z",
      };
    },
    "/nonexistent",
  );
  service.mode = "live";
  service.settings.connectors.jira.enabled = true;
  store.upsert("live", jira());
  const p = service.propose(
    "jira:APP-1",
    "comment",
    "once",
    "Test",
    "2026-09-14T09:00:00Z",
  );
  const result = await service.execute(p.id);
  assert.equal(result.state, "succeeded");
  assert.match(result.result, /follow-up refresh failed/);
  assert.equal(writes, 1);
  store.close();
});
