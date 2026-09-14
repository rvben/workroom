import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import { Sessions } from "../server/sessions.js";
const exec = promisify(execFile);

test(
  "real CLI queues offline, flushes through authenticated HTTP, and preserves the session",
  { timeout: 30000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "workroom-cli-reporting-"));
    const portServer = createServer();
    await new Promise<void>((resolve) =>
      portServer.listen(0, "127.0.0.1", resolve),
    );
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const token = randomBytes(32).toString("hex");
    writeFileSync(join(root, "agent-token"), token, { mode: 0o600 });
    const store = new Store(join(root, "workroom.sqlite"));
    const sessions = new Sessions(
      new Service(store, undefined, "/no-cli-reporting-config"),
    );
    const item = store
      .items("demo")
      .find((i) => i.source === "jira" && !i.closed)!;
    const s = await sessions.start(
      await sessions.plan({
        itemId: item.id,
        repositoryId: "demo-payments",
        branch: "APP-1/cli",
        owner: "agent",
        objective: "Report offline",
        acceptance: "Exactly one event arrives",
      }),
    );
    const claim = sessions.claim(s.id, "terminal-agent");
    store.close();
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      WORKROOM_DATA_DIR: root,
      WORKROOM_URL: base,
      PORT: String(port),
      WORKROOM_REPORT_TOKEN: claim.reportingToken,
      WORKROOM_ATTEMPT_ID: claim.attemptId,
    };
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(
            process.execPath,
            ["--import", "tsx", "server/cli.ts", ...args],
            { env },
          )
        ).stdout,
      );
    const eventId = randomUUID();
    writeFileSync(
      join(root, "event.json"),
      JSON.stringify({
        id: eventId,
        kind: "decision",
        summary: "Persist before delivery",
      }),
    );
    let server: ReturnType<typeof spawn> | undefined;
    try {
      const offline = await cli("event", s.id, join(root, "event.json"));
      assert.equal(offline.remaining, 1);
      assert.equal(offline.delivered, 0);
      assert.equal((await cli("outbox"))[0].id, eventId);
      server = spawn(
        process.execPath,
        ["--import", "tsx", "server/index.ts", "--production"],
        { env, stdio: "ignore" },
      );
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/session")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      const unauthorized = await fetch(
        base + `/api/work/sessions/${s.id}/events`,
      );
      assert.equal(unauthorized.status, 401);
      const flushed = await cli("flush");
      assert.equal(flushed.remaining, 0);
      assert.equal(flushed.delivered, 1);
      const page = await cli("events", s.id);
      assert.equal(page.events.filter((e: any) => e.id === eventId).length, 1);
      assert.equal(
        page.events.find((e: any) => e.id === eventId).source,
        "agent",
      );
      assert.equal((await cli("session", s.id)).version, claim.session.version);
    } finally {
      if (server && server.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
          server!.once("exit", () => resolve()),
        );
        server.kill("SIGTERM");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
