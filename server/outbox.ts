import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { EventInput } from "../shared/events.js";
export const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Each row is committed before network delivery. Concurrent flushes are safe through server deduplication. */
export class Outbox {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,target TEXT,credential TEXT,sessionId TEXT,payload TEXT,queuedAt TEXT,lastError TEXT DEFAULT '');`);
    if (
      !this.db
        .prepare("PRAGMA table_info(pending)")
        .all()
        .some((r) => r.name === "heldReason")
    )
      this.db.exec("ALTER TABLE pending ADD COLUMN heldReason TEXT DEFAULT ''");
  }
  inspect(id: string) {
    const row = this.db
      .prepare(
        "SELECT id,sessionId,payload,queuedAt,lastError,heldReason FROM pending WHERE id=?",
      )
      .get(id);
    if (!row)
      throw new Error(
        "Queued event not found; it may already have been delivered.",
      );
    return { ...row, payload: JSON.parse(String(row.payload)) };
  }
  hold(id: string, reason: string) {
    if (!reason.trim() || reason.length > 500)
      throw new Error("Give a hold reason of 1–500 characters.");
    this.inspect(id);
    this.db
      .prepare("UPDATE pending SET heldReason=? WHERE id=?")
      .run(reason.trim(), id);
    return this.inspect(id);
  }
  release(id: string) {
    this.inspect(id);
    this.db.prepare("UPDATE pending SET heldReason='' WHERE id=?").run(id);
    return this.inspect(id);
  }
  enqueue(
    target: string,
    credential: string,
    sessionId: string,
    event: EventInput,
  ) {
    const payload = JSON.stringify(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO pending(id,target,credential,sessionId,payload,queuedAt) VALUES(?,?,?,?,?,?)",
        )
        .run(
          event.id,
          target,
          credential,
          sessionId,
          payload,
          new Date().toISOString(),
        );
      const row = this.db
        .prepare("SELECT * FROM pending WHERE id=?")
        .get(event.id)!;
      if (
        row.target !== target ||
        row.credential !== credential ||
        row.sessionId !== sessionId ||
        row.payload !== payload
      )
        throw new Error(
          "This queued event ID already has different content. Preserve it and create a correction with a new ID.",
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  status() {
    return this.db
      .prepare(
        "SELECT id,sessionId,queuedAt,lastError,heldReason FROM pending ORDER BY rowid",
      )
      .all();
  }
  async flush(
    target: string,
    credential: string,
    deliver: (sessionId: string, event: EventInput) => Promise<unknown>,
  ) {
    const rows = this.db
      .prepare(
        "SELECT id,sessionId,payload FROM pending WHERE target=? AND credential=? AND heldReason='' ORDER BY rowid",
      )
      .all(target, credential);
    let delivered = 0;
    let error: string | null = null;
    for (const row of rows) {
      // A hold made by another process stops subsequent delivery, but cannot retract an in-flight request.
      const pending = this.db
        .prepare("SELECT heldReason FROM pending WHERE id=?")
        .get(row.id);
      if (!pending) {
        delivered++;
        continue;
      }
      if (pending.heldReason) continue;
      try {
        await deliver(String(row.sessionId), JSON.parse(String(row.payload)));
        this.db.prepare("DELETE FROM pending WHERE id=?").run(row.id);
        delivered++;
      } catch (e) {
        error = (e as Error).message;
        this.db
          .prepare("UPDATE pending SET lastError=? WHERE id=?")
          .run(error.slice(0, 1000), row.id);
        break; // Preserve order, including correction references. Never silently drop a rejected event.
      }
    }
    return {
      delivered,
      remaining: this.status().length,
      matchingRemaining: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM pending WHERE target=? AND credential=? AND heldReason=''",
          )
          .get(target, credential)!.count,
      ),
      held: this.status().filter((r) => Boolean(r.heldReason)).length,
      error,
    };
  }
  close() {
    this.db.close();
  }
}
