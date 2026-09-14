import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import { Sessions } from "../server/sessions.js";
import { Outbox, fingerprint } from "../server/outbox.js";
import { eventSchema } from "../shared/events.js";

async function fixture(path = ":memory:") {
  const store = new Store(path);
  const service = new Service(store, undefined, "/no-reporting-test-config");
  const sessions = new Sessions(service);
  const item = store
    .items("demo")
    .find((i) => i.source === "jira" && !i.closed)!;
  const s = await sessions.start(
    await sessions.plan({
      itemId: item.id,
      repositoryId: "demo-payments",
      branch: "APP-1/reporting",
      owner: "agent",
      objective: "Test durable reporting",
      acceptance: "History survives retry",
    }),
  );
  const claim = sessions.claim(s.id, "test-agent", {
    agent: "example-cli",
    id: "native-conversation-1",
  });
  const event = (extra = {}) =>
    eventSchema.parse({
      id: randomUUID(),
      attemptId: claim.attemptId,
      occurredAt: new Date().toISOString(),
      kind: "finding",
      summary: "Found retry cause",
      ...extra,
    });
  return { store, sessions, claim, s, event };
}

test("duplicate delivery is idempotent; conflicting IDs and forged provenance are rejected", async () => {
  const f = await fixture();
  try {
    const input = f.event({
      evidence: [
        {
          label: "Recovery test",
          kind: "test",
          reference: "test/recovery.test.ts",
        },
      ],
    });
    const first = f.sessions.event(f.s.id, input, f.claim.reportingToken);
    assert.equal(first.event.actor, "test-agent");
    assert.equal(first.event.conversation?.id, "native-conversation-1");
    assert.equal(first.event.source, "agent");
    assert.equal(
      f.sessions.event(f.s.id, input, f.claim.reportingToken).duplicate,
      true,
    );
    assert.throws(
      () =>
        f.sessions.event(
          f.s.id,
          { ...input, summary: "Changed" },
          f.claim.reportingToken,
        ),
      /different content/,
    );
    assert.throws(() =>
      f.sessions.event(
        f.s.id,
        { ...input, source: "workroom" },
        f.claim.reportingToken,
      ),
    );
    assert.throws(
      () => f.sessions.event(f.s.id, input, f.claim.leaseToken),
      /credential/,
    );
    assert.equal(
      f.sessions.events(f.s.id).events.filter((e) => e.source === "agent")
        .length,
      1,
    );
    assert.equal(f.sessions.get(f.s.id).version, f.claim.session.version);
  } finally {
    f.store.close();
  }
});

test("historical delivery after handoff records history without reviving ownership or state", async () => {
  const f = await fixture();
  try {
    const input = f.event();
    const s = f.sessions.handoff(
      f.s.id,
      f.claim.session.version,
      "human",
      "Taking over",
      "",
      true,
    );
    const late = f.sessions.event(s.id, input, f.claim.reportingToken);
    assert.equal(late.event.historical, true);
    assert.deepEqual(f.sessions.get(s.id), s);
    assert.throws(
      () => f.sessions.heartbeat(s.id, f.claim.reportingToken),
      /lease/,
    );
    assert.throws(
      () => f.sessions.heartbeat(s.id, f.claim.leaseToken),
      /lease/,
    );
    f.sessions.handoff(s.id, s.version, "agent", "Continue", "", true);
    const next = f.sessions.claim(s.id, "another-agent");
    assert.throws(
      () => f.sessions.event(s.id, f.event(), next.reportingToken),
      /credential/,
    );
    assert.equal(
      f.sessions.event(s.id, f.event(), f.claim.reportingToken).event
        .historical,
      true,
    );
    assert.equal(f.sessions.get(s.id).leaseOwner, "another-agent");
  } finally {
    f.store.close();
  }
});

test("expired leases allow append-only history and do not renew on delivery", async () => {
  const f = await fixture();
  try {
    const s = f.sessions.get(f.s.id);
    s.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    f.sessions.save("demo", s);
    assert.equal(
      f.sessions.event(s.id, f.event(), f.claim.reportingToken).event
        .historical,
      true,
    );
    assert.equal(f.sessions.get(s.id).leaseExpiresAt, s.leaseExpiresAt);
  } finally {
    f.store.close();
  }
});

test("corrections preserve originals and stay within the reporting attempt", async () => {
  const f = await fixture();
  try {
    const original = f.sessions.event(
      f.s.id,
      f.event(),
      f.claim.reportingToken,
    ).event;
    const correction = f.event({
      kind: "correction",
      summary: "Updated finding",
      corrects: original.id,
    });
    f.sessions.event(f.s.id, correction, f.claim.reportingToken);
    assert.equal(
      f.store.event("demo", original.id)?.summary,
      "Found retry cause",
    );
    assert.throws(
      () =>
        f.sessions.event(
          f.s.id,
          f.event({ kind: "correction", corrects: randomUUID() }),
          f.claim.reportingToken,
        ),
      /existing agent event/,
    );
    assert.throws(() => f.event({ kind: "correction" }), /correction/);
    assert.throws(
      () =>
        f.sessions.event(
          f.s.id,
          f.event({ occurredAt: new Date(Date.now() + 3600000).toISOString() }),
          f.claim.reportingToken,
        ),
      /future/,
    );
  } finally {
    f.store.close();
  }
});

test("receipt cursors preserve late arrivals and paginate in both directions", async () => {
  const f = await fixture();
  try {
    const first = f.sessions.events(f.s.id, 0, 1);
    assert.equal(first.events.length, 1);
    const late = f.sessions.event(
      f.s.id,
      f.event({ occurredAt: "2026-01-01T12:00:00Z" }),
      f.claim.reportingToken,
    ).event;
    const later = f.sessions.events(f.s.id, first.nextCursor, 1);
    assert.equal(later.events[0].id, late.id);
    assert.equal(later.hasMore, false);
    const latest = f.sessions.events(f.s.id, 0, 1, Number.MAX_SAFE_INTEGER);
    assert.equal(latest.events[0].id, late.id);
    assert.equal(latest.hasMore, true);
    assert.equal(
      f.sessions.events(f.s.id, 0, 1, latest.nextCursor).events[0].kind,
      "claim",
    );
    assert.equal(f.store.events("live", f.s.id).events.length, 0);
  } finally {
    f.store.close();
  }
});

test("report snapshots preserve prior tests; failed timeline writes roll back state changes", async () => {
  const f = await fixture();
  try {
    let s = f.sessions.report(
      f.s.id,
      {
        version: f.claim.session.version,
        summary: "First",
        tests: "First suite passed",
      },
      f.claim.leaseToken,
      false,
    );
    s = f.sessions.report(
      f.s.id,
      { version: s.version, summary: "Second", tests: "Second suite failed" },
      f.claim.leaseToken,
      false,
    );
    const reports = f.sessions
      .events(s.id)
      .events.filter((e) => e.kind === "report");
    assert.match(reports[0].detail, /First suite passed/);
    assert.match(reports[1].detail, /Second suite failed/);
    const append = f.store.appendEvent;
    f.store.appendEvent = () => {
      throw new Error("Disk failure");
    };
    assert.throws(
      () =>
        f.sessions.report(
          s.id,
          { version: s.version, summary: "Must not persist" },
          f.claim.leaseToken,
          false,
        ),
      /Disk failure/,
    );
    f.store.appendEvent = append;
    assert.equal(f.sessions.get(s.id).summary, "Second");
    assert.equal(f.sessions.get(s.id).version, s.version);
  } finally {
    f.store.close();
  }
});

test("outbox survives restart and lost acknowledgement without duplicate events or credentials on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "workroom-reporting-"));
  const f = await fixture(join(root, "server.sqlite"));
  let outbox = new Outbox(join(root, "outbox.sqlite"));
  try {
    const input = f.event();
    const target = fingerprint("loopback-server");
    const credential = fingerprint(f.claim.reportingToken);
    outbox.enqueue(target, credential, f.s.id, input);
    const lost = await outbox.flush(target, credential, async (id, e) => {
      f.sessions.event(id, e, f.claim.reportingToken);
      throw new Error("Acknowledgement lost");
    });
    assert.equal(lost.remaining, 1);
    outbox.close();
    f.store.close();
    outbox = new Outbox(join(root, "outbox.sqlite"));
    const store = new Store(join(root, "server.sqlite"));
    try {
      const sessions = new Sessions(
        new Service(store, undefined, "/no-reporting-test-config"),
      );
      let calls = 0;
      await outbox.flush("other-server", credential, async () => {
        calls++;
      });
      await outbox.flush(target, "other-credential", async () => {
        calls++;
      });
      assert.equal(calls, 0);
      const replay = await outbox.flush(target, credential, async (id, e) =>
        sessions.event(id, e, f.claim.reportingToken),
      );
      assert.equal(replay.remaining, 0);
      assert.equal(
        sessions.events(f.s.id).events.filter((e) => e.id === input.id).length,
        1,
      );
    } finally {
      store.close();
    }
    assert.equal(
      readFileSync(join(root, "outbox.sqlite")).includes(
        f.claim.reportingToken,
      ),
      false,
    );
  } finally {
    outbox.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("outbox preserves rejected events and ordered corrections", async () => {
  const f = await fixture();
  const outbox = new Outbox(":memory:");
  try {
    const first = f.event(),
      correction = f.event({ kind: "correction", corrects: first.id });
    outbox.enqueue("target", "credential", f.s.id, first);
    outbox.enqueue("target", "credential", f.s.id, correction);
    assert.throws(
      () =>
        outbox.enqueue("target", "credential", f.s.id, {
          ...first,
          summary: "overwrite",
        }),
      /different content/,
    );
    let calls = 0;
    const failed = await outbox.flush("target", "credential", async () => {
      calls++;
      throw new Error("Credential rejected");
    });
    assert.equal(calls, 1);
    assert.equal(failed.remaining, 2);
    const flushed = await outbox.flush("target", "credential", async (id, e) =>
      f.sessions.event(id, e, f.claim.reportingToken),
    );
    assert.equal(flushed.remaining, 0);
  } finally {
    f.store.close();
    outbox.close();
  }
});

test("holding a rejected event preserves its body and allows independent delivery", async () => {
  const f = await fixture(),
    outbox = new Outbox(":memory:");
  try {
    const first = f.event(),
      second = f.event();
    outbox.enqueue("target", "credential", f.s.id, first);
    outbox.enqueue("target", "credential", f.s.id, second);
    outbox.hold(first.id, "Inspect original reference before retrying");
    let flushed = await outbox.flush("target", "credential", async (id, e) =>
      f.sessions.event(id, e, f.claim.reportingToken),
    );
    assert.equal(flushed.delivered, 1);
    assert.equal(flushed.held, 1);
    assert.equal(flushed.remaining, 1);
    assert.deepEqual(outbox.inspect(first.id).payload, first);
    outbox.release(first.id);
    flushed = await outbox.flush("target", "credential", async (id, e) =>
      f.sessions.event(id, e, f.claim.reportingToken),
    );
    assert.equal(flushed.remaining, 0);
  } finally {
    f.store.close();
    outbox.close();
  }
});
