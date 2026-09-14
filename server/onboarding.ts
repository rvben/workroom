import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SOURCES, type Source } from "../shared/types.js";
import {
  AGENTS,
  TOOLS,
  type ToolId,
  type ToolCheck,
  type SetupState,
  type SetupOverview,
  type ConnectionCheck,
  type InstallJob,
} from "../shared/onboarding.js";
import { Service, configSchema, developmentSchema } from "./service.js";
import { Adapter, type Runner } from "./adapters.js";
import { inspectRepository } from "./git.js";
import { projectParts } from "../shared/mrs.js";
import { toolRun, type ToolRunner } from "./tool-process.js";
import { processExists } from "./terminal-sessions.js";
import type { JiraProjects } from "../shared/jira-scope.js";
import {
  normalizeGitLabHost,
  canonicalGitLabProject,
  type GitLabProjectPage,
  type MailFolderPage,
} from "../shared/backend-scopes.js";
const stateSchema = z
  .object({
    version: z.number().int(),
    step: z.number().int().min(0).max(3),
    services: z.array(z.enum(SOURCES)).max(4),
    agents: z.array(z.enum(AGENTS)).max(3),
    configs: z.object({
      jira: configSchema,
      gitlab: configSchema,
      servicenow: configSchema,
      outlook: configSchema,
    }),
    development: developmentSchema,
    dismissed: z.boolean(),
    completedAt: z.string(),
  })
  .strict();
export const signature = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Onboarding {
  private checking?: Promise<SetupOverview>;
  private verifying = new Set<Source>();
  private connections: ConnectionCheck[] = [];
  private checks: ToolCheck[] = [];
  private managers: Record<string, boolean> = {};
  constructor(
    private service: Service,
    private run: ToolRunner = toolRun,
    public platform = process.platform,
    private alive = processExists,
    private connectorRunner?: Runner,
  ) {
    const job = this.job();
    if (job?.state === "running")
      this.service.store.set("setup:install", {
        ...job,
        state: "interrupted",
        detail:
          "Workroom restarted during installation. Check the package manager before retrying.",
      });
  }
  state(): SetupState {
    const state = this.service.store.get<SetupState>("setup:state", {
      version: 0,
      step: 0,
      services: SOURCES.filter(
        (s) => this.service.settings.connectors[s].enabled,
      ),
      agents: this.service.settings.agents?.enabled || [],
      configs: structuredClone(this.service.settings.connectors),
      development: structuredClone(
        this.service.settings.development || {
          repositories: [],
          teamMembers: [],
        },
      ),
      dismissed: false,
      completedAt: "",
    });
    for (const source of SOURCES)
      state.configs[source].executable =
        this.service.settings.connectors[source].executable;
    state.development ||= structuredClone(
      this.service.settings.development || {
        repositories: [],
        teamMembers: [],
      },
    );
    return state;
  }
  job(): (InstallJob & { pid?: number }) | null {
    return this.service.store.get("setup:install", null);
  }
  overview(): SetupOverview {
    const job = this.job();
    return {
      state: this.state(),
      platform: this.platform,
      checks: this.checks,
      managers: this.managers,
      connections: this.connections,
      job: job
        ? {
            id: job.id,
            tool: job.tool,
            installer: job.installer,
            command: job.command,
            state: job.state,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            detail: job.detail,
          }
        : null,
    };
  }
  save(input: unknown) {
    const x = stateSchema.parse(input),
      current = this.state();
    if (current.version !== x.version)
      throw new Error(
        "Setup changed in another window. Reload setup before saving.",
      );
    for (const s of SOURCES)
      if (
        x.configs[s].executable !==
        this.service.settings.connectors[s].executable
      )
        throw new Error(
          "Set custom executable paths in workroom.config.json, then restart Workroom.",
        );
    const next = {
      ...x,
      services: [...new Set(x.services)],
      agents: [...new Set(x.agents)],
      version: x.version + 1,
      completedAt: current.completedAt,
    };
    this.service.store.set("setup:state", next);
    this.connections = this.connections.filter(
      (c) => c.signature === signature(next.configs[c.source]),
    );
    return this.overview();
  }
  async check() {
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  private async performCheck() {
    const checks: ToolCheck[] = [];
    // Bounded batches keep CLI startup from overwhelming the work machine.
    for (let offset = 0; offset < TOOLS.length; offset += 3)
      await Promise.all(
        TOOLS.slice(offset, offset + 3).map(async (t) => {
          const exe = SOURCES.includes(t.id as Source)
            ? this.service.settings.connectors[t.id as Source].executable
            : t.executable;
          const checkedAt = new Date().toISOString();
          try {
            const versionText = await this.run(exe, ["--version"]);
            const help = await this.run(exe, ["--help"]);
            const required =
              t.id === "jira"
                ? ["--output", "search"]
                : t.id === "gitlab"
                  ? ["mr", "auth"]
                  : t.id === "servicenow"
                    ? ["incidents", "--output"]
                    : t.id === "outlook"
                      ? ["mail", "--output"]
                      : t.id === "claude"
                        ? ["--plugin-dir", "--session-id", "--resume"]
                        : [];
            const supported = required.every((flag) => help.includes(flag));
            checks.push({
              id: t.id,
              state: supported ? "available" : "incompatible",
              version:
                versionText.match(/\b\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/)?.[0] ||
                "Detected",
              detail: supported
                ? "Executable and required commands found."
                : "This executable lacks required commands. Check its identity or update it using your package manager.",
              checkedAt,
              guidedAuth: /\bauth\b/.test(help),
            });
          } catch (e) {
            checks.push({
              id: t.id,
              state:
                (e as { code?: string }).code === "ENOENT"
                  ? "missing"
                  : "error",
              version: "",
              detail:
                (e as { code?: string }).code === "ENOENT"
                  ? "Not found on this machine."
                  : "The CLI could not start. Try its version command in your terminal.",
              checkedAt,
              guidedAuth: false,
            });
          }
        }),
      );
    const managers: Record<string, boolean> = {};
    await Promise.all(
      ["uv", "cargo", "brew", "npm", "pipx", "git"].map(async (m) => {
        try {
          await this.run(m, ["--version"]);
          managers[m] = true;
        } catch {
          managers[m] = false;
        }
      }),
    );
    this.checks = checks;
    this.managers = managers;
    return this.overview();
  }
  async jiraProjects(version: number): Promise<JiraProjects> {
    const state = this.state();
    if (state.version !== version)
      throw new Error(
        "Setup changed. Save your current profile before loading projects.",
      );
    const adapter = new Adapter(
      "jira",
      structuredClone(state.configs.jira),
      this.connectorRunner,
    );
    const user = await adapter.call(["myself"]);
    if (!user.accountId && !user.name)
      throw new Error(
        "Sign in with the selected Jira profile, then load projects again.",
      );
    const data = await adapter.call(["projects", "list"]);
    const rows = z
      .array(
        z.object({
          key: z.string().min(1).max(255),
          name: z.string().min(1).max(500),
        }),
      )
      .parse(data.projects);
    if (signature(state.configs.jira) !== signature(this.state().configs.jira))
      throw new Error(
        "The Jira profile changed while loading projects. Load them again.",
      );
    return {
      projects: rows.slice(0, 500),
      limited:
        rows.length > 500 ||
        (typeof data.total === "number" && data.total > rows.length),
    };
  }
  async gitlabProjects(input: unknown): Promise<GitLabProjectPage> {
    const x = z
      .object({
        version: z.number().int(),
        host: z.string().min(1).max(255),
        search: z.string().max(100).default(""),
        page: z.number().int().min(1).max(100).default(1),
      })
      .strict()
      .parse(input);
    const state = this.state();
    if (state.version !== x.version)
      throw new Error(
        "Setup changed. Save your GitLab settings before loading projects.",
      );
    const host = normalizeGitLabHost(x.host),
      adapter = new Adapter(
        "gitlab",
        structuredClone(state.configs.gitlab),
        this.connectorRunner,
      );
    const user = await adapter.call([
      "api",
      "user",
      "--hostname",
      host,
      "--method",
      "GET",
    ]);
    if (!user.id)
      throw new Error("Sign in to this GitLab host before loading projects.");
    const query = new URLSearchParams({
      membership: "true",
      simple: "true",
      archived: "false",
      per_page: "100",
      page: String(x.page),
      order_by: "name",
      sort: "asc",
    });
    if (x.search.trim()) query.set("search", x.search.trim());
    const data = await adapter.call([
      "api",
      `projects?${query}`,
      "--hostname",
      host,
      "--method",
      "GET",
    ]);
    const rows = z
      .array(
        z.object({
          path_with_namespace: z.string().min(1).max(300),
          name_with_namespace: z.string().min(1).max(600).optional(),
          name: z.string().min(1).max(300),
        }),
      )
      .max(100)
      .parse(data);
    if (
      signature(state.configs.gitlab) !== signature(this.state().configs.gitlab)
    )
      throw new Error(
        "GitLab settings changed while loading projects. Load them again.",
      );
    return {
      host,
      page: x.page,
      more: rows.length === 100 && x.page < 100,
      projects: rows.map((r) => ({
        project: canonicalGitLabProject(host, r.path_with_namespace),
        name: r.name_with_namespace || r.name,
        path: r.path_with_namespace,
      })),
    };
  }
  async outlookFolders(input: unknown): Promise<MailFolderPage> {
    const x = z
      .object({
        version: z.number().int(),
        parent: z.string().min(1).max(4000).optional(),
        cursor: z.string().max(8000).optional(),
      })
      .strict()
      .parse(input);
    const state = this.state();
    if (state.version !== x.version)
      throw new Error(
        "Setup changed. Save your Outlook profile before loading folders.",
      );
    const adapter = new Adapter(
      "outlook",
      structuredClone(state.configs.outlook),
      this.connectorRunner,
    );
    const data = await adapter.call([
      "mail",
      "folders",
      "--limit",
      "100",
      ...(x.parent ? ["--parent", x.parent] : []),
      ...(x.cursor ? ["--cursor", x.cursor] : []),
    ]);
    const page = z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().min(1).max(4000),
              displayName: z.string().min(1).max(500),
              childFolderCount: z.number().int().nonnegative().optional(),
            }),
          )
          .max(100),
        next_cursor: z.string().max(8000).nullish(),
        truncated: z.boolean().optional(),
      })
      .parse(data);
    if (
      signature(state.configs.outlook) !==
      signature(this.state().configs.outlook)
    )
      throw new Error(
        "Outlook profile or folder changed while loading folders. Load them again.",
      );
    return {
      folders: page.items.map((r) => ({
        id: r.id,
        name: r.displayName,
        children: r.childFolderCount || 0,
      })),
      cursor: page.next_cursor || "",
      limited: !!page.truncated,
    };
  }
  async verify(source: Source) {
    if (this.verifying.has(source))
      throw new Error("This connection check is already running.");
    this.verifying.add(source);
    const config = structuredClone(this.state().configs[source]),
      sig = signature(config);
    let result: ConnectionCheck = {
      source,
      state: "error",
      detail: "",
      count: 0,
      limited: false,
      checkedAt: new Date().toISOString(),
      signature: sig,
      sample: [],
    };
    try {
      const adapter = new Adapter(source, config, this.connectorRunner);
      if (source === "jira") {
        const user = await adapter.call(["myself"]);
        if (!user.accountId && !user.name)
          throw new Error(
            "Jira authentication was not confirmed. Sign in with the selected profile.",
          );
      }
      if (source === "gitlab") {
        if (!config.repositories.length)
          throw new Error("Add a GitLab host/group/project to verify access.");
        for (const host of new Set(
          config.repositories.map((r) => projectParts(r).host),
        )) {
          const user = await adapter.call(["api", "user", "--hostname", host]);
          if (!user.id)
            throw new Error(
              "GitLab authentication was not confirmed for a configured host.",
            );
        }
      }
      const collection = await adapter.collect();
      result = {
        ...result,
        state: "ready",
        count: collection.items.length,
        limited: collection.limited,
        sample: collection.items
          .slice(0, 3)
          .map((i) => ({ key: i.key, title: i.title })),
        detail: collection.items.length
          ? "Connection and collection verified."
          : "Connection succeeded. This query returned no items; adjust the scope if you expected work.",
      };
    } catch (e) {
      result.detail = (e as Error).message;
    } finally {
      this.verifying.delete(source);
    }
    if (sig !== signature(this.state().configs[source]))
      throw new Error(
        "Connection settings changed during verification. Test the saved settings again.",
      );
    this.connections = this.connections
      .filter((c) => c.source !== source)
      .concat(result);
    return this.overview();
  }
  async install(input: unknown) {
    const x = z
      .object({
        tool: z.enum(TOOLS.map((t) => t.id) as [ToolId, ...ToolId[]]),
        installer: z.string(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(input);
    const tool = TOOLS.find((t) => t.id === x.tool)!,
      method = tool.installers.find((i) => i.id === x.installer);
    if (!method || !method.platforms.includes(this.platform))
      throw new Error(
        "This installation method is not supported on this platform. Use the official installation guide.",
      );
    const old = this.job();
    if (old?.state === "running" || (old?.pid && this.alive(old.pid)))
      throw new Error(
        "A package installation is still running. Let it finish before installing another tool.",
      );
    // Check again at execution time; browser status may be stale.
    await this.run(method.manager, ["--version"]);
    if (this.job()?.state === "running")
      throw new Error("A package installation is already running.");
    let installPid: number | undefined;
    const job: InstallJob = {
      id: randomUUID(),
      tool: tool.id,
      installer: method.id,
      command: [method.manager, ...method.args].join(" "),
      state: "running",
      startedAt: new Date().toISOString(),
      detail:
        "Installing on the Workroom host. You can leave this page; progress is saved.",
    };
    this.service.store.set("setup:install", job);
    void this.run(method.manager, method.args, 10 * 60 * 1000, (pid) => {
      installPid = pid;
      this.service.store.set("setup:install", { ...job, pid });
    }).then(
      async () => {
        let available = false;
        try {
          await this.run(
            SOURCES.includes(tool.id as Source)
              ? this.service.settings.connectors[tool.id as Source].executable
              : tool.executable,
            ["--version"],
          );
          available = true;
        } catch {}
        this.service.store.set("setup:install", {
          ...job,
          state: available ? "succeeded" : "failed",
          finishedAt: new Date().toISOString(),
          detail: available
            ? "Package installed and executable found. Recheck tools, then sign in."
            : "The package manager finished, but the configured executable is unavailable. Check its path or restart Workroom from your terminal.",
        });
      },
      () =>
        this.service.store.set("setup:install", {
          ...job,
          state: "failed",
          pid: installPid,
          finishedAt: new Date().toISOString(),
          detail:
            "Installation did not finish successfully. Run the displayed command in your terminal for package-manager diagnostics. Partial installation may remain.",
        }),
    );
    return this.overview();
  }
  async repository(id: string) {
    const repo = this.state().development.repositories.find((r) => r.id === id);
    if (!repo) throw new Error("Choose a saved local repository.");
    const result = await inspectRepository(
      repo,
      "workroom-setup/" + randomUUID(),
    );
    return {
      id,
      detail:
        "Repository root and base commit verified. No branch or files were created.",
      baseSha: result.sha,
      warnings: result.warnings,
    };
  }
  async finish(version: number) {
    const state = this.state();
    if (state.version !== version)
      throw new Error(
        "Setup changed after review. Reload setup and review your choices again.",
      );
    const ready = state.services.filter((s) =>
      this.connections.some(
        (c) =>
          c.source === s &&
          c.state === "ready" &&
          c.signature === signature(state.configs[s]) &&
          Date.now() - Date.parse(c.checkedAt) < 10 * 60 * 1000,
      ),
    );
    if (!ready.length)
      throw new Error(
        "Verify at least one connection before opening the live inbox.",
      );
    const settings = structuredClone(this.service.settings);
    for (const s of SOURCES)
      settings.connectors[s] = {
        ...state.configs[s],
        enabled: ready.includes(s),
      };
    settings.agents = { enabled: state.agents };
    settings.development = state.development;
    settings.mode = "live";
    this.service.saveSettings(settings);
    this.service.store.set("setup:state", {
      ...state,
      completedAt: new Date().toISOString(),
      dismissed: false,
      version: state.version + 1,
    });
    await this.service.sync();
    return this.service.snapshot();
  }
}
