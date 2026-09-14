import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { z } from "zod";
import { Store } from "./store.js";
import { TerminalSessions } from "./terminal-sessions.js";
import { Sessions } from "./sessions.js";
import { suggestBranch } from "./git.js";
import { Service } from "./service.js";
import { Onboarding } from "./onboarding.js";
import { SOURCES } from "../shared/types.js";
const dataDir = resolve(process.env.WORKROOM_DATA_DIR || ".data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const tokenPath = resolve(dataDir, "agent-token");
if (!existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
const agentToken = readFileSync(tokenPath, "utf8").trim();
const browserToken = randomBytes(32).toString("hex");
const store = new Store(resolve(dataDir, "workroom.sqlite"));
const service = new Service(store);
const onboarding = new Onboarding(service);
const sessions = new Sessions(service);
const terminal = new TerminalSessions(sessions);
const app = express();
const port = Number(process.env.PORT || 4310);
app.disable("x-powered-by");
app.use((req, res, next) => {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host || ""))
    return res.status(403).json({ error: "Unrecognised host." });
  const origin = req.headers.origin;
  if (
    origin &&
    !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(
      origin,
    )
  )
    return res.status(403).json({ error: "Cross-origin request blocked." });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "100kb" }));
app.get("/api/session", (_req, res) => res.json({ token: browserToken }));
function matches(a: string, b: string) {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
app.use("/api", (req, res, next) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, "") || "";
  const ui = String(req.headers["x-workroom-token"] || "");
  if (!matches(bearer, agentToken) && !matches(ui, browserToken))
    return res.status(401).json({ error: "Authentication required." });
  res.locals.isBrowser = matches(ui, browserToken);
  next();
});
app.get("/api/snapshot", (_req, res) => res.json(service.snapshot()));
app.get("/api/settings", (_req, res) => res.json(service.settings));
app.put("/api/settings", (req, res) => {
  if (!res.locals.isBrowser)
    return res
      .status(403)
      .json({ error: "Connection settings are managed from the UI." });
  res.json(service.saveSettings(req.body));
});
app.post("/api/sync", async (req, res) => {
  const source = z.enum(SOURCES).optional().parse(req.body?.source);
  res.json(await service.sync(source));
});
app.get("/api/items/:id", async (req, res) =>
  res.json(
    await service.detail(String(req.params.id), req.query.refresh !== "false"),
  ),
);
app.patch("/api/items/:id/local", (req, res) => {
  const id = String(req.params.id);
  if (!store.item(service.mode, id))
    return res.status(404).json({ error: "Item not found." });
  const values = z
    .object({
      note: z.string().max(20000).optional(),
      snoozedUntil: z.union([z.iso.datetime(), z.literal("")]).optional(),
    })
    .strict()
    .parse(req.body);
  store.local(service.mode, id, values);
  store.log(
    service.mode,
    id,
    values.note !== undefined
      ? "Private note saved"
      : values.snoozedUntil
        ? "Snoozed"
        : "Returned to attention",
    values.snoozedUntil || "",
  );
  res.json({ ok: true });
});
app.patch("/api/links/:id", (req, res) => {
  const state = z.enum(["confirmed", "dismissed"]).parse(req.body.state);
  const link = store.links(service.mode).find((l) => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: "Link not found." });
  store.saveLink(service.mode, { ...link, state });
  store.log(service.mode, link.from, `Relationship ${state}`, link.evidence);
  res.json({ ok: true });
});

const browserOnly: express.RequestHandler = (_req, res, next) => {
  if (!res.locals.isBrowser) {
    res.status(403).json({ error: "Review this action in Workroom." });
    return;
  }
  next();
};
const lease = (req: express.Request) =>
  String(req.headers["x-workroom-lease"] || "");
app.get("/api/setup", browserOnly, (_req, res) =>
  res.json(onboarding.overview()),
);
app.post("/api/setup/state", browserOnly, (req, res) =>
  res.json(onboarding.save(req.body)),
);
app.post("/api/setup/check", browserOnly, async (_req, res) =>
  res.json(await onboarding.check()),
);
app.post("/api/setup/jira/projects", browserOnly, async (req, res) =>
  res.json(
    await onboarding.jiraProjects(z.number().int().parse(req.body.version)),
  ),
);
app.post("/api/setup/verify/:source", browserOnly, async (req, res) =>
  res.json(await onboarding.verify(z.enum(SOURCES).parse(req.params.source))),
);
app.post("/api/setup/install", browserOnly, async (req, res) =>
  res.json(await onboarding.install(req.body)),
);
app.post("/api/setup/repository/:id", browserOnly, async (req, res) =>
  res.json(await onboarding.repository(String(req.params.id))),
);
app.post("/api/setup/finish", browserOnly, async (_req, res) =>
  res.json(await onboarding.finish(z.number().int().parse(_req.body.version))),
);

app.get("/api/work/options", (req, res) => {
  const item = store.item(service.mode, String(req.query.itemId));
  res.json({
    repositories: sessions.repositories(),
    branch: item ? suggestBranch(item.key, item.title) : "",
  });
});
app.get("/api/work/sessions", (_req, res) =>
  res.json(store.sessions(service.mode)),
);
app.post("/api/work/plan", browserOnly, async (req, res) =>
  res.json(await sessions.plan(req.body)),
);
app.post("/api/work/start", browserOnly, async (req, res) =>
  res.json(await sessions.start(req.body)),
);
app.get("/api/work/sessions/:id", (req, res) =>
  res.json(sessions.get(String(req.params.id))),
);
app.get("/api/work/sessions/:id/packet", (req, res) =>
  res.json(sessions.packet(String(req.params.id))),
);
app.post("/api/work/sessions/:id/claim", (req, res) =>
  res.json(
    sessions.claim(
      String(req.params.id),
      z.string().trim().min(1).max(100).parse(req.body.agent),
      req.body.conversation,
    ),
  ),
);
app.get("/api/work/sessions/:id/terminal", (req, res) =>
  res.json(terminal.list(String(req.params.id))),
);
app.post("/api/work/sessions/:id/terminal", (req, res) =>
  res.json(terminal.start(String(req.params.id), req.body)),
);
app.get("/api/terminal/:id", (req, res) =>
  res.json(terminal.get(String(req.params.id))),
);
app.post("/api/terminal/:id/running", (req, res) =>
  res.json(
    terminal.running(
      String(req.params.id),
      lease(req),
      z.number().int().min(2).parse(req.body.childPid),
    ),
  ),
);
app.post("/api/terminal/:id/check", (req, res) =>
  res.json(terminal.check(String(req.params.id), lease(req))),
);
app.post("/api/terminal/:id/heartbeat", (req, res) =>
  res.json(terminal.heartbeat(String(req.params.id), lease(req))),
);
app.post("/api/terminal/:id/finish", (req, res) =>
  res.json(
    terminal.finish(
      String(req.params.id),
      String(req.headers["x-workroom-report"] || ""),
      z.number().int().nullable().parse(req.body.exitCode),
    ),
  ),
);
app.post("/api/terminal/:id/reconcile", (req, res) =>
  res.json(terminal.reconcile(String(req.params.id))),
);
app.post("/api/terminal/:id/events", (req, res) =>
  res.json(
    terminal.capture(
      String(req.params.id),
      req.body,
      String(req.headers["x-workroom-report"] || ""),
    ),
  ),
);
app.get("/api/work/sessions/:id/reporting", (req, res) =>
  res.json(sessions.reportingAccess(String(req.params.id))),
);
app.post("/api/work/sessions/:id/reporting/:attemptId/verify", (req, res) => {
  sessions.reportingAttempt(
    String(req.params.id),
    String(req.params.attemptId),
    String(req.headers["x-workroom-report"] || ""),
  );
  res.json({ valid: true });
});
app.post(
  "/api/work/sessions/:id/reporting/:attemptId/:action",
  browserOnly,
  (req, res) => {
    const action = z.enum(["rotate", "revoke"]).parse(req.params.action);
    const version = z
      .number()
      .int()
      .positive()
      .parse(req.body.credentialVersion);
    res.json(
      sessions.manageReporting(
        String(req.params.id),
        String(req.params.attemptId),
        action,
        version,
      ),
    );
  },
);
app.get("/api/work/sessions/:id/events", (req, res) => {
  const after = z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .parse(req.query.after ?? 0);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(req.query.limit ?? 100);
  const before =
    req.query.before === undefined
      ? undefined
      : z.coerce
          .number()
          .int()
          .min(1)
          .max(Number.MAX_SAFE_INTEGER)
          .parse(req.query.before);
  res.json(sessions.events(String(req.params.id), after, limit, before));
});
app.post("/api/work/sessions/:id/events", (req, res) =>
  res.json(
    sessions.event(
      String(req.params.id),
      req.body,
      String(req.headers["x-workroom-report"] || ""),
    ),
  ),
);
app.post("/api/work/sessions/:id/report", (req, res) =>
  res.json(
    sessions.report(
      String(req.params.id),
      req.body,
      lease(req),
      res.locals.isBrowser,
    ),
  ),
);
app.post("/api/work/sessions/:id/heartbeat", (req, res) =>
  res.json(sessions.heartbeat(String(req.params.id), lease(req))),
);
app.post("/api/work/sessions/:id/handoff", (req, res) => {
  const x = z
    .object({
      version: z.number().int(),
      to: z.enum(["human", "agent"]),
      summary: z.string().trim().min(1).max(15000),
    })
    .parse(req.body);
  res.json(
    sessions.handoff(
      String(req.params.id),
      x.version,
      x.to,
      x.summary,
      lease(req),
      res.locals.isBrowser,
    ),
  );
});
app.post(
  "/api/work/sessions/:id/prepare-publication",
  browserOnly,
  async (req, res) => {
    const x = z
      .object({
        title: z.string().trim().min(1).max(250),
        description: z.string().max(30000),
      })
      .parse(req.body);
    res.json(
      await sessions.preparePublish(
        String(req.params.id),
        x.title,
        x.description,
      ),
    );
  },
);
app.post("/api/work/sessions/:id/publish", browserOnly, async (req, res) =>
  res.json(
    await sessions.publish(
      String(req.params.id),
      z.number().int().parse(req.body.version),
    ),
  ),
);
app.get("/api/activity", (_req, res) => res.json(store.activity(service.mode)));
app.post("/api/proposals", (req, res) => {
  const p = z
    .object({
      itemId: z.string(),
      action: z.enum(["comment", "transition", "note"]),
      body: z.string().trim().min(1).max(20000),
      actor: z.string().trim().min(1).max(100).default("Agent"),
      expectedUpdatedAt: z.string(),
    })
    .parse(req.body);
  res
    .status(201)
    .json(
      service.propose(
        p.itemId,
        p.action,
        p.body,
        res.locals.isBrowser ? "You" : p.actor,
        p.expectedUpdatedAt,
      ),
    );
});
app.post("/api/proposals/:id/execute", async (req, res) => {
  if (!res.locals.isBrowser)
    return res.status(403).json({
      error: "A person must review and execute this update in the UI.",
    });
  res.json(await service.execute(String(req.params.id)));
});
app.post("/api/proposals/:id/reject", (req, res) => {
  const p = store.proposal(service.mode, String(req.params.id));
  if (!p || p.state !== "pending")
    return res.status(409).json({ error: "Proposal is not pending." });
  p.state = "rejected";
  p.result = "Declined without changing the source.";
  store.saveProposal(service.mode, p);
  store.log(service.mode, p.itemId, "Proposal declined", p.body);
  res.json(p);
});
app.use("/api", (err: any, _req: any, res: any, _next: any) => {
  res.status(err instanceof z.ZodError ? 400 : 409).json({
    error:
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join("; ")
        : err.message || "Request failed.",
  });
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown API route." }),
);
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, "127.0.0.1", (error?: Error) => {
  if (error) {
    console.error(`Could not start Workroom: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `Workroom: http://127.0.0.1:${port}\nAgent token: ${tokenPath}\nMode: ${service.mode}. No live writes run automatically.`,
  );
});
let lastRefresh = Date.now();
const timer = setInterval(() => {
  if (
    Date.now() - lastRefresh > service.settings.refreshMinutes * 60000 &&
    !service.syncing
  ) {
    lastRefresh = Date.now();
    void service.sync();
  }
}, 10000);
timer.unref();
async function shutdown() {
  clearInterval(timer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
