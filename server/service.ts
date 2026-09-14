import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  SOURCES,
  type Source,
  type Settings,
  type Mode,
  type ConnectorState,
  type Detail,
  type Proposal,
} from "../shared/types.js";
import { Store } from "./store.js";
import { Adapter, CliError, type Runner } from "./adapters.js";
import { buildLinks, text } from "./normalize.js";
import { seedDemo, upgradeDemoMrs } from "./demo.js";
export const configSchema = z.object({
  enabled: z.boolean(),
  executable: z.string().min(1).max(500),
  profile: z.string().max(100),
  query: z.string().max(3000),
  baseUrl: z
    .string()
    .refine(
      (s) => !s || /^https?:\/\/[^\s]+$/.test(s),
      "Use an HTTP or HTTPS URL",
    ),
  repositories: z.array(z.string().min(1).max(300)).max(20),
  folder: z.string().max(4000),
});
export const developmentSchema = z.object({
  repositories: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        name: z.string().min(1).max(100),
        path: z.string().min(1).max(1000),
        project: z.string().min(1).max(300),
        baseBranch: z.string().min(1).max(200),
      }),
    )
    .max(30)
    .refine(
      (rows) => new Set(rows.map((r) => r.id)).size === rows.length,
      "Repository IDs must be unique.",
    ),
  teamMembers: z.array(z.string().min(1).max(100)).max(100),
});
export const settingsSchema = z.object({
  mode: z.enum(["live", "demo"]),
  agents: z
    .object({ enabled: z.array(z.enum(["codex", "claude", "cline"])).max(3) })
    .default({ enabled: [] }),
  development: developmentSchema.default({ repositories: [], teamMembers: [] }),
  refreshMinutes: z.number().int().min(1).max(120),
  connectors: z.object({
    jira: configSchema,
    gitlab: configSchema,
    servicenow: configSchema,
    outlook: configSchema,
  }),
});
export function defaults(): Settings {
  return {
    mode: "demo",
    refreshMinutes: 5,
    connectors: Object.fromEntries(
      SOURCES.map((source) => [
        source,
        {
          enabled: false,
          executable: source === "gitlab" ? "glab" : source,
          profile: "",
          query: "",
          baseUrl: "",
          repositories: [],
          folder: "inbox",
        },
      ]),
    ) as unknown as Settings["connectors"],
  };
}
export class Service {
  settings: Settings;
  syncing = false;
  busy = new Set<Source>();
  mode: Mode;
  constructor(
    public store: Store,
    private runner?: Runner,
    configPath = "workroom.config.json",
  ) {
    let settings = store.get<Settings>("settings", defaults());
    if (existsSync(configPath)) {
      const file = JSON.parse(readFileSync(configPath, "utf8"));
      settings = {
        ...settings,
        ...file,
        connectors: Object.fromEntries(
          SOURCES.map((s) => [
            s,
            { ...settings.connectors[s], ...file.connectors?.[s] },
          ]),
        ) as unknown as Settings["connectors"],
      };
    }
    this.settings = settingsSchema.parse(settings);
    this.mode = settings.mode;
    seedDemo(store);
    upgradeDemoMrs(store);
    this.relink("demo");
  }
  adapter(s: Source) {
    return new Adapter(s, this.settings.connectors[s], this.runner);
  }
  relink(mode = this.mode) {
    this.store.reconcileLinks(mode, buildLinks(this.store.items(mode)));
  }
  states(): ConnectorState[] {
    return SOURCES.map((source) => ({
      ...this.store.get<any>(`sync:${this.mode}:${source}`, {
        lastSuccess: null,
        lastAttempt: null,
        error: null,
        count: this.store.items(this.mode).filter((i) => i.source === source)
          .length,
        limited: false,
      }),
      source,
      enabled: this.mode === "demo" || this.settings.connectors[source].enabled,
      syncing: this.busy.has(source),
    }));
  }
  snapshot() {
    const enabled = new Set(
      SOURCES.filter(
        (s) => this.mode === "demo" || this.settings.connectors[s].enabled,
      ),
    );
    return {
      items: this.store.items(this.mode).filter((i) => enabled.has(i.source)),
      links: this.store.links(this.mode).filter((l) =>
        [l.from, l.to].every((id) => {
          const i = this.store.item(this.mode, id);
          return i && enabled.has(i.source);
        }),
      ),
      proposals: this.store.proposals(this.mode),
      sessions: this.store.sessions(this.mode),
      teamMembers: this.settings.development?.teamMembers || [],
      connectors: this.states(),
      mode: this.mode,
      syncing: this.syncing,
    };
  }
  saveSettings(value: unknown) {
    if (this.store.terminalRuns(this.mode).some((r) => r.state !== "stopped"))
      throw new Error(
        "Stop or reconcile active terminal runs before changing connections.",
      );
    if (
      this.syncing ||
      this.store.proposals(this.mode).some((p) => p.state === "executing") ||
      this.store
        .sessions(this.mode)
        .some(
          (s) =>
            s.state === "preparing" ||
            ["pushing", "creating"].includes(s.publication?.state || ""),
        )
    )
      throw new Error(
        "Wait for the refresh to finish before changing connections.",
      );
    const next = settingsSchema.parse(value);
    for (const s of SOURCES)
      if (
        next.connectors[s].executable !== this.settings.connectors[s].executable
      )
        throw new Error(
          "Executable paths can only be changed in workroom.config.json, followed by a restart.",
        );
    this.settings = next;
    this.mode = next.mode;
    this.store.set("settings", next);
    return next;
  }
  async sync(source?: Source) {
    if (
      this.syncing ||
      this.store.proposals(this.mode).some((p) => p.state === "executing")
    )
      return this.snapshot();
    this.syncing = true;
    const mode = this.mode;
    try {
      await Promise.all(
        SOURCES.filter(
          (s) =>
            (!source || s === source) &&
            (mode === "demo" || this.settings.connectors[s].enabled),
        ).map(async (s) => {
          this.busy.add(s);
          const prev = this.store.get<any>(`sync:${mode}:${s}`, {});
          const state = {
            ...prev,
            lastAttempt: new Date().toISOString(),
            error: null,
            limited: false,
          };
          try {
            if (mode === "live") {
              const result = await this.adapter(s).collect();
              this.store.replaceSource(mode, s, result.items);
              state.count = result.items.length;
              state.limited = result.limited;
            } else
              state.count = this.store
                .items(mode)
                .filter((i) => i.source === s).length;
            state.lastSuccess = new Date().toISOString();
          } catch (e) {
            state.error = e instanceof Error ? e.message : "Refresh failed.";
          } finally {
            this.store.set(`sync:${mode}:${s}`, state);
            this.busy.delete(s);
          }
        }),
      );
      this.relink(mode);
    } finally {
      this.syncing = false;
    }
    return this.snapshot();
  }
  async detail(id: string, refresh = true): Promise<Detail> {
    const mode = this.mode;
    let item = this.store.item(mode, id);
    if (!item) throw new Error("Work item not found.");
    let detailError = "",
      transitions: { id: string; name: string }[] = [];
    if (
      mode === "live" &&
      refresh &&
      this.settings.connectors[item.source].enabled
    ) {
      try {
        const fetched = await this.adapter(item.source).detail(item);
        if (fetched.id !== item.id)
          throw new Error("Source returned a different record identifier.");
        this.store.upsert(mode, fetched);
        item = this.store.item(mode, id)!;
        this.relink(mode);
      } catch (e) {
        detailError = (e as Error).message;
      }
    }
    if (item.source === "jira") {
      if (mode === "demo")
        transitions = ["To Do", "In Progress", "In Review", "Done"]
          .filter((s) => s !== item.status)
          .map((name, i) => ({ id: String(i + 1), name }));
      else
        try {
          transitions = await this.adapter("jira").transitions(item);
        } catch (e) {
          detailError ||= (e as Error).message;
        }
    }
    const links = this.store
      .links(mode)
      .filter((l) => l.state !== "dismissed" && (l.from === id || l.to === id));
    const ids = new Set(links.flatMap((l) => [l.from, l.to]));
    return {
      item,
      sessions: this.store.sessions(mode).filter((s) => s.itemId === id),
      links,
      related: this.store
        .items(mode)
        .filter(
          (i) =>
            i.id !== id &&
            ids.has(i.id) &&
            (mode === "demo" || this.settings.connectors[i.source].enabled),
        ),
      activity: this.store.activity(mode, id),
      comments: (item.raw.comments || []).map((c: any) => ({
        id: String(c.id),
        author: text(c.author),
        body: text(c.body),
        created: text(c.created),
      })),
      transitions,
      detailError,
    };
  }
  propose(
    itemId: string,
    action: Proposal["action"],
    body: string,
    actor: string,
    expectedUpdatedAt: string,
  ) {
    const i = this.store.item(this.mode, itemId);
    if (!i) throw new Error("Work item not found.");
    if (!(
      (i.source === "jira" && ["comment", "transition"].includes(action)) ||
      (i.source === "servicenow" && action === "note")
    ))
      throw new Error("This action is not supported for this source.");
    if (i.updatedAt !== expectedUpdatedAt)
      throw new Error(
        "Item changed. Reload the details before proposing this update.",
      );
    const p = this.store.createProposal(this.mode, {
      itemId,
      action,
      body,
      actor,
      expectedUpdatedAt,
    });
    this.store.log(
      this.mode,
      itemId,
      "Update proposed",
      `${action}: ${body}`,
      actor,
    );
    return p;
  }
  async execute(id: string) {
    if (this.syncing)
      throw new Error(
        "Wait for the current refresh to finish, then send this proposal.",
      );
    const mode = this.mode;
    const p = this.store.proposal(mode, id);
    if (!p || p.state !== "pending")
      throw new Error("Only a pending proposal can be executed.");
    const item = this.store.item(mode, p.itemId);
    if (!item) throw new Error("Work item no longer in the snapshot.");
    if (mode === "live" && !this.settings.connectors[item.source].enabled)
      throw new Error("Enable this connector first.");
    p.state = "executing";
    this.store.saveProposal(mode, p);
    try {
      if (mode === "live") {
        const latest = await this.adapter(item.source).detail(item);
        if (latest.id !== item.id)
          throw new CliError("Source returned a different record.");
        if (!latest.updatedAt || latest.updatedAt !== p.expectedUpdatedAt)
          throw new CliError(
            "Source changed since this update was prepared. Refresh and create a new proposal.",
          );
        if (p.action === "transition") {
          const options = await this.adapter("jira").transitions(latest);
          if (!options.some((t) => t.name === p.body))
            throw new CliError("This transition is no longer available.");
        }
        await this.adapter(item.source).execute(item, p);
      } else {
        const raw = { ...item.raw };
        if (p.action === "transition") {
          raw.status = p.body;
          item.status = p.body;
          item.closed = p.body === "Done";
          item.score = item.closed ? 0 : 40;
        } else
          raw.comments = [
            ...(raw.comments || []),
            {
              id: p.id,
              body: p.body,
              author: { displayName: "You" },
              created: new Date().toISOString(),
            },
          ];
        item.raw = raw;
        item.updatedAt = new Date().toISOString();
        this.store.upsert(mode, item);
      }
      p.state = "succeeded";
      p.result =
        mode === "demo"
          ? "Applied to demo data only."
          : "Source accepted the update.";
      if (mode === "live") {
        try {
          const refreshed = await this.adapter(item.source).detail(item);
          if (refreshed.id !== item.id)
            throw new Error("Unexpected source record.");
          this.store.upsert(mode, refreshed);
          this.relink(mode);
        } catch {
          p.result +=
            " The follow-up refresh failed; refresh this item to see its latest state.";
        }
      }
      this.store.log(
        mode,
        p.itemId,
        p.action === "transition" ? "Status changed" : "Update sent",
        p.body,
        "You",
      );
    } catch (e) {
      p.state = e instanceof CliError && e.uncertain ? "uncertain" : "failed";
      p.result = (e as Error).message;
      this.store.log(mode, p.itemId, `Update ${p.state}`, p.result, "System");
    }
    this.store.saveProposal(mode, p);
    return p;
  }
}
