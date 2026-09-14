import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorkItem,
  Link,
  Source,
  Mode,
  Activity,
  Proposal,
  WorkSession,
} from "../shared/types.js";
import type {
  WorkEvent,
  ReportingAttempt,
  EventPage,
} from "../shared/events.js";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS items(mode TEXT,id TEXT,source TEXT,data TEXT, PRIMARY KEY(mode,id));
      CREATE TABLE IF NOT EXISTS local(mode TEXT,id TEXT,note TEXT DEFAULT '',snooze TEXT DEFAULT '', PRIMARY KEY(mode,id));
      CREATE TABLE IF NOT EXISTS links(mode TEXT,id TEXT,data TEXT, PRIMARY KEY(mode,id));
      CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT,mode TEXT,itemId TEXT,at TEXT,title TEXT,detail TEXT,actor TEXT);
      CREATE TABLE IF NOT EXISTS proposals(mode TEXT,id TEXT,data TEXT,PRIMARY KEY(mode,id));
      CREATE TABLE IF NOT EXISTS sessions(mode TEXT,id TEXT,itemId TEXT,state TEXT,version INTEGER,data TEXT,claimHash TEXT DEFAULT '',PRIMARY KEY(mode,id));
      CREATE UNIQUE INDEX IF NOT EXISTS active_session ON sessions(mode,itemId) WHERE state NOT IN ('completed','failed');
      CREATE TABLE IF NOT EXISTS reporting_attempts(mode TEXT,id TEXT,sessionId TEXT,data TEXT,PRIMARY KEY(mode,id));
      CREATE TABLE IF NOT EXISTS work_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,mode TEXT,id TEXT,sessionId TEXT,data TEXT,UNIQUE(mode,id));
      CREATE INDEX IF NOT EXISTS session_events ON work_events(mode,sessionId,sequence);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);`);
    // A restart cannot establish whether a remote write completed.
    for (const mode of ["live", "demo"] as Mode[])
      for (const p of this.proposals(mode))
        if (p.state === "executing")
          this.saveProposal(mode, {
            ...p,
            state: "uncertain",
            result:
              "Server restarted during execution. Verify the source before creating another action.",
          });
  }
  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return r ? JSON.parse(String(r.value)) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO kv VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  items(mode: Mode): WorkItem[] {
    return this.db
      .prepare(
        `SELECT i.data,l.note,l.snooze FROM items i LEFT JOIN local l ON i.mode=l.mode AND i.id=l.id WHERE i.mode=?`,
      )
      .all(mode)
      .map((r) => ({
        ...JSON.parse(String(r.data)),
        note: r.note || "",
        snoozedUntil: r.snooze || "",
      }));
  }
  item(mode: Mode, id: string) {
    return this.items(mode).find((i) => i.id === id);
  }
  upsert(mode: Mode, item: WorkItem) {
    this.db
      .prepare("INSERT OR REPLACE INTO items VALUES (?,?,?,?)")
      .run(mode, item.id, item.source, JSON.stringify(item));
  }
  replaceSource(mode: Mode, source: Source, items: WorkItem[]) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM items WHERE mode=? AND source=?")
        .run(mode, source);
      for (const i of items) this.upsert(mode, i);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  local(
    mode: Mode,
    id: string,
    values: { note?: string; snoozedUntil?: string },
  ) {
    this.db
      .prepare("INSERT OR IGNORE INTO local(mode,id) VALUES (?,?)")
      .run(mode, id);
    if (values.note !== undefined)
      this.db
        .prepare("UPDATE local SET note=? WHERE mode=? AND id=?")
        .run(values.note, mode, id);
    if (values.snoozedUntil !== undefined)
      this.db
        .prepare("UPDATE local SET snooze=? WHERE mode=? AND id=?")
        .run(values.snoozedUntil, mode, id);
  }
  links(mode: Mode): Link[] {
    return this.db
      .prepare("SELECT data FROM links WHERE mode=?")
      .all(mode)
      .map((r) => JSON.parse(String(r.data)));
  }
  saveLink(mode: Mode, l: Link) {
    this.db
      .prepare("INSERT OR REPLACE INTO links VALUES (?,?,?)")
      .run(mode, l.id, JSON.stringify(l));
  }
  reconcileLinks(mode: Mode, links: Link[]) {
    const old = this.links(mode);
    this.db.prepare("DELETE FROM links WHERE mode=?").run(mode);
    for (const l of links) {
      const prev = old.find((o) => o.id === l.id);
      this.saveLink(
        mode,
        prev && ["confirmed", "dismissed"].includes(prev.state) ? prev : l,
      );
    }
    for (const l of old.filter(
      (l) =>
        ["confirmed", "dismissed"].includes(l.state) &&
        !links.some((n) => n.id === l.id),
    ))
      this.saveLink(mode, l);
  }
  log(mode: Mode, itemId: string, title: string, detail = "", actor = "You") {
    this.db
      .prepare(
        "INSERT INTO activity(mode,itemId,at,title,detail,actor) VALUES (?,?,?,?,?,?)",
      )
      .run(mode, itemId, new Date().toISOString(), title, detail, actor);
  }
  activity(mode: Mode, itemId?: string): Activity[] {
    return this.db
      .prepare(
        `SELECT id,itemId,at,title,detail,actor FROM activity WHERE mode=? ${itemId ? "AND itemId=?" : ""} ORDER BY id DESC LIMIT 100`,
      )
      .all(...(itemId ? [mode, itemId] : [mode])) as unknown as Activity[];
  }
  proposals(mode: Mode): Proposal[] {
    return this.db
      .prepare("SELECT data FROM proposals WHERE mode=?")
      .all(mode)
      .map((r) => JSON.parse(String(r.data)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  saveProposal(mode: Mode, p: Proposal) {
    this.db
      .prepare("INSERT OR REPLACE INTO proposals VALUES (?,?,?)")
      .run(mode, p.id, JSON.stringify(p));
  }
  proposal(mode: Mode, id: string) {
    return this.proposals(mode).find((p) => p.id === id);
  }
  createProposal(
    mode: Mode,
    p: Omit<Proposal, "id" | "state" | "createdAt" | "result">,
  ) {
    const result: Proposal = {
      ...p,
      id: randomUUID(),
      state: "pending",
      createdAt: new Date().toISOString(),
      result: "",
    };
    this.saveProposal(mode, result);
    return result;
  }
  sessions(mode: Mode): WorkSession[] {
    return this.db
      .prepare("SELECT data FROM sessions WHERE mode=? ORDER BY rowid DESC")
      .all(mode)
      .map((r) => JSON.parse(String(r.data)));
  }
  session(mode: Mode, id: string): WorkSession | undefined {
    const r = this.db
      .prepare("SELECT data FROM sessions WHERE mode=? AND id=?")
      .get(mode, id);
    return r ? JSON.parse(String(r.data)) : undefined;
  }
  insertSession(mode: Mode, s: WorkSession) {
    this.db
      .prepare(
        "INSERT INTO sessions(mode,id,itemId,state,version,data) VALUES (?,?,?,?,?,?)",
      )
      .run(mode, s.id, s.itemId, s.state, s.version, JSON.stringify(s));
  }
  updateSession(
    mode: Mode,
    s: WorkSession,
    expected: number,
    claimHash?: string,
  ) {
    const sql =
      claimHash === undefined
        ? "UPDATE sessions SET state=?,version=?,data=? WHERE mode=? AND id=? AND version=?"
        : "UPDATE sessions SET state=?,version=?,data=?,claimHash=? WHERE mode=? AND id=? AND version=?";
    const args: any[] = [
      s.state,
      s.version,
      JSON.stringify(s),
      ...(claimHash === undefined ? [] : [claimHash]),
      mode,
      s.id,
      expected,
    ];
    if (this.db.prepare(sql).run(...args).changes !== 1)
      throw new Error("Session changed. Reload before updating it.");
  }
  claimHash(mode: Mode, id: string) {
    return String(
      this.db
        .prepare("SELECT claimHash FROM sessions WHERE mode=? AND id=?")
        .get(mode, id)?.claimHash || "",
    );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  saveAttempt(mode: Mode, attempt: ReportingAttempt) {
    this.db
      .prepare("INSERT INTO reporting_attempts VALUES (?,?,?,?)")
      .run(mode, attempt.id, attempt.sessionId, JSON.stringify(attempt));
  }
  attempt(mode: Mode, id: string): ReportingAttempt | undefined {
    const row = this.db
      .prepare("SELECT data FROM reporting_attempts WHERE mode=? AND id=?")
      .get(mode, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  attemptForLease(
    mode: Mode,
    sessionId: string,
    hash: string,
  ): ReportingAttempt | undefined {
    return this.db
      .prepare(
        "SELECT data FROM reporting_attempts WHERE mode=? AND sessionId=?",
      )
      .all(mode, sessionId)
      .map((row) => JSON.parse(String(row.data)) as ReportingAttempt)
      .find((a) => a.leaseHash === hash);
  }
  event(mode: Mode, id: string): WorkEvent | undefined {
    const row = this.db
      .prepare("SELECT sequence,data FROM work_events WHERE mode=? AND id=?")
      .get(mode, id);
    return row
      ? { ...JSON.parse(String(row.data)), sequence: Number(row.sequence) }
      : undefined;
  }
  appendEvent(mode: Mode, event: Omit<WorkEvent, "sequence">): WorkEvent {
    const result = this.db
      .prepare(
        "INSERT INTO work_events(mode,id,sessionId,data) VALUES (?,?,?,?)",
      )
      .run(mode, event.id, event.sessionId, JSON.stringify(event));
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }
  events(
    mode: Mode,
    sessionId: string,
    after = 0,
    limit = 100,
    before?: number,
  ): EventPage {
    const rows = this.db
      .prepare(
        `SELECT sequence,data FROM work_events WHERE mode=? AND sessionId=? AND sequence${before === undefined ? ">" : "<"}? ORDER BY sequence ${before === undefined ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(mode, sessionId, before ?? after, limit + 1);
    const events = rows
      .slice(0, limit)
      .map((row) => ({
        ...JSON.parse(String(row.data)),
        sequence: Number(row.sequence),
      })) as WorkEvent[];
    return {
      events,
      nextCursor: events.at(-1)?.sequence ?? before ?? after,
      hasMore: rows.length > limit,
    };
  }
  close() {
    this.db.close();
  }
}
