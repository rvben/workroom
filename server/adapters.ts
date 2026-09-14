import { projectParts } from "../shared/mrs.js";
import { execFile } from "node:child_process";
import { resolveCommand } from "./tool-process.js";
import {
  buildIncidentQuery,
  DEFAULT_INCIDENT_SCOPE,
} from "../shared/backend-scopes.js";
import type {
  Source,
  ConnectorConfig,
  WorkItem,
  Proposal,
} from "../shared/types.js";
import { listPayload, normalize } from "./normalize.js";
export class CliError extends Error {
  constructor(
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
export type Runner = (
  exe: string,
  args: string[],
  write?: boolean,
) => Promise<any>;
export const run: Runner = (exe, args, write = false) =>
  new Promise((resolve, reject) => {
    // No shell, no command strings, no credentials in diagnostics.
    const child = execFile(
      resolveCommand(exe),
      args,
      {
        timeout: 45_000,
        maxBuffer: 12 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
          JIRA_DEBUG_HTTP: "0",
          SERVICENOW_VERBOSE: "false",
          ...(!write
            ? { JIRA_READ_ONLY: "1", SERVICENOW_READ_ONLY: "true" }
            : {}),
        },
      },
      (error, stdout) => {
        if (error) {
          const code = String(error.code);
          const message =
            code === "ENOENT"
              ? "CLI executable not found. Install it or set its path in workroom.config.json."
              : code === "3"
                ? "Authentication or permission check failed. Sign in using the CLI on this machine."
                : code === "6"
                  ? "Service rate limit reached. Wait before retrying."
                  : code === "2"
                    ? "CLI configuration or arguments rejected. Check the configured profile and CLI version."
                    : error.killed
                      ? "CLI timed out."
                      : `CLI failed (exit ${code}). Check the CLI connection in your terminal.`;
          reject(
            new CliError(
              message,
              write && !["ENOENT", "2", "3", "4", "6"].includes(code),
            ),
          );
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : {});
        } catch {
          reject(new CliError("CLI returned invalid JSON.", write));
        }
      },
    );
    child.stdin?.end();
  });
export class Adapter {
  constructor(
    public source: Source,
    public config: ConnectorConfig,
    private runner: Runner = run,
  ) {}
  private args(args: string[]) {
    return [
      ...(this.config.profile && this.source !== "gitlab"
        ? ["--profile", this.config.profile]
        : []),
      ...(this.source === "gitlab" ? [] : ["--output", "json", "--quiet"]),
      ...args,
    ];
  }
  call(args: string[], write = false) {
    return this.runner(this.config.executable, this.args(args), write);
  }
  async collect(): Promise<{ items: WorkItem[]; limited: boolean }> {
    let data: any,
      limited = false;
    if (this.source === "jira") {
      data = await this.call([
        "search",
        this.config.query ||
          "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
        "--limit",
        "100",
      ]);
      limited =
        data.total === null ||
        data.total > data.items?.length ||
        data.items?.length >= 100;
    }
    if (this.source === "servicenow") {
      data = await this.call([
        "incidents",
        "list",
        "--query",
        this.config.query || buildIncidentQuery(DEFAULT_INCIDENT_SCOPE),
        "--limit",
        "100",
        "--display-value",
        "all",
        "--fields",
        "sys_id,number,short_description,description,state,priority,assigned_to,sys_updated_on",
      ]);
      limited = data.result?.length >= 100;
    }
    if (this.source === "outlook") {
      data = await this.call(
        this.config.query
          ? [
              "mail",
              "search",
              this.config.query,
              "--folder",
              this.config.folder || "inbox",
              "--limit",
              "100",
            ]
          : [
              "mail",
              "list",
              "--folder",
              this.config.folder || "inbox",
              "--limit",
              "100",
            ],
      );
      limited = !!data.next_cursor || !!data.truncated;
    }
    if (this.source === "gitlab") {
      if (!this.config.repositories.length)
        throw new CliError(
          "Add at least one GitLab repository in Connections.",
        );
      const rows: any[] = [];
      const viewers = new Map<string, any>();
      for (const repo of this.config.repositories) {
        const host = projectParts(repo).host;
        if (!viewers.has(host)) {
          try {
            viewers.set(
              host,
              await this.call(["api", "user", "--hostname", host]),
            );
          } catch {
            viewers.set(host, null);
          }
        }
        const result = await this.call([
          "mr",
          "list",
          "--repo",
          repo,
          "--output",
          "json",
          "--per-page",
          "100",
          "--page",
          "1",
        ]);
        const batch = listPayload("gitlab", result);
        limited ||= batch.length >= 100;
        rows.push(
          ...batch.map((r) => ({
            ...r,
            _repository: repo,
            _viewer: viewers.get(host),
            _host: host,
          })),
        );
      }
      data = rows;
    }
    const mapped = listPayload(this.source, data).map((r) =>
      normalize(this.source, r, this.config.baseUrl),
    );
    return {
      items: [...new Map(mapped.map((r) => [r.id, r])).values()],
      limited,
    };
  }
  async detail(item: WorkItem): Promise<WorkItem> {
    let raw: any;
    if (this.source === "jira")
      raw = await this.call(["issues", "show", item.key]);
    if (this.source === "servicenow")
      raw = (
        await this.call([
          "incidents",
          "show",
          item.key,
          "--display-value",
          "all",
        ])
      ).result;
    if (this.source === "outlook")
      raw = await this.call(["mail", "read", String(item.raw.id)]);
    if (this.source === "gitlab") {
      raw = {
        ...(await this.call([
          "mr",
          "view",
          String(item.raw.iid),
          "--repo",
          item.raw._repository,
          "--output",
          "json",
        ])),
        _repository: item.raw._repository,
        _viewer: item.raw._viewer,
        _host: item.raw._host,
      };
      const project = projectParts(item.raw._repository);
      const endpoint =
        "projects/" +
        encodeURIComponent(project.path) +
        "/merge_requests/" +
        item.raw.iid;
      const checks = await Promise.allSettled([
        this.call(["api", endpoint + "/approvals", "--hostname", project.host]),
        this.call([
          "api",
          endpoint + "/discussions?per_page=100",
          "--hostname",
          project.host,
        ]),
      ]);
      if (checks[0].status === "fulfilled") raw._approvals = checks[0].value;
      if (checks[1].status === "fulfilled") raw._discussions = checks[1].value;
    }
    if (!raw || Array.isArray(raw))
      throw new CliError("Unexpected detail format.");
    // Outlook bodies are deliberately not rendered as HTML; preview text remains safe.
    return normalize(this.source, raw, this.config.baseUrl);
  }
  async transitions(item: WorkItem) {
    if (this.source !== "jira") return [];
    const rows = await this.call(["issues", "list-transitions", item.key]);
    if (!Array.isArray(rows))
      throw new CliError("Unexpected transitions format.");
    return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
  }
  async execute(item: WorkItem, p: Proposal) {
    if (this.source === "jira" && p.action === "comment")
      return this.call(["issues", "comment", item.key, "--body", p.body], true);
    if (this.source === "jira" && p.action === "transition")
      return this.call(
        ["issues", "transition", item.key, "--to", p.body],
        true,
      );
    if (this.source === "servicenow" && p.action === "note")
      return this.call(["incidents", "note", item.key, "--", p.body], true);
    throw new CliError("This source action is not supported.");
  }
}
