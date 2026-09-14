import type { ConnectorConfig, Source, DevelopmentSettings } from "./types.js";
export const AGENTS = ["codex", "claude", "cline"] as const;
export type AgentId = (typeof AGENTS)[number];
export type ToolId = Source | AgentId;
export type Installer = {
  id: string;
  manager: string;
  args: string[];
  platforms: string[];
  label: string;
};
export type ToolDefinition = {
  id: ToolId;
  name: string;
  executable: string;
  purpose: string;
  docs: string;
  installers: Installer[];
  native?: boolean;
};
const unix = ["darwin", "linux"];
const cargo = (name: string): Installer => ({
  id: "cargo",
  manager: "cargo",
  args: ["install", name, "--locked"],
  platforms: unix,
  label: "Cargo · builds from source",
});
const uv = (name: string): Installer => ({
  id: "uv",
  manager: "uv",
  args: ["tool", "install", "--no-build", name],
  platforms: unix,
  label: "uv · prebuilt package",
});
const npm = (name: string): Installer => ({
  id: "npm",
  manager: "npm",
  args: ["install", "--global", name],
  platforms: unix,
  label: "npm · global install",
});
export const TOOLS: ToolDefinition[] = [
  {
    id: "jira",
    name: "Jira",
    executable: "jira",
    purpose: "Tickets, comments and status changes.",
    docs: "https://github.com/rvben/jira-cli",
    installers: [uv("jira-cli-rs"), cargo("jira-cli")],
  },
  {
    id: "gitlab",
    name: "GitLab",
    executable: "glab",
    purpose: "Your MRs, team reviews and pipelines.",
    docs: "https://docs.gitlab.com/cli/",
    installers: [
      {
        id: "brew",
        manager: "brew",
        args: ["install", "glab"],
        platforms: unix,
        label: "Homebrew",
      },
    ],
  },
  {
    id: "servicenow",
    name: "ServiceNow",
    executable: "servicenow",
    purpose: "Incidents assigned to you or your groups.",
    docs: "https://github.com/rvben/servicenow-cli",
    installers: [
      {
        id: "pipx",
        manager: "pipx",
        args: ["install", "servicenow-cli"],
        platforms: unix,
        label: "pipx",
      },
      cargo("servicenow-cli"),
    ],
  },
  {
    id: "outlook",
    name: "Outlook",
    executable: "outlook",
    purpose: "Email related to your tickets and incidents.",
    docs: "https://github.com/rvben/outlook-cli",
    installers: [uv("outlook-cli-rs"), cargo("outlook-cli")],
  },
  {
    id: "codex",
    name: "Codex",
    executable: "codex",
    purpose:
      "Use the shared context and report progress with the Workroom CLI.",
    docs: "https://developers.openai.com/codex/cli",
    installers: [npm("@openai/codex")],
  },
  {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    purpose:
      "Continue in your terminal with native hooks and same-conversation resume.",
    docs: "https://code.claude.com/docs/en/quickstart",
    native: true,
    installers: [
      {
        id: "brew",
        manager: "brew",
        args: ["install", "--cask", "claude-code"],
        platforms: ["darwin"],
        label: "Homebrew",
      },
    ],
  },
  {
    id: "cline",
    name: "Cline",
    executable: "cline",
    purpose:
      "Use the shared context and report progress with the Workroom CLI.",
    docs: "https://docs.cline.bot/getting-started/installing-cline",
    installers: [npm("cline")],
  },
];
export interface ToolCheck {
  id: ToolId;
  state: "available" | "missing" | "incompatible" | "error";
  version: string;
  detail: string;
  checkedAt: string;
  guidedAuth: boolean;
}
export interface SetupState {
  version: number;
  step: number;
  services: Source[];
  agents: AgentId[];
  configs: Record<Source, ConnectorConfig>;
  development: DevelopmentSettings;
  dismissed: boolean;
  completedAt: string;
}
export interface ConnectionCheck {
  source: Source;
  state: "ready" | "error";
  detail: string;
  count: number;
  limited: boolean;
  checkedAt: string;
  signature: string;
  sample: { key: string; title: string }[];
}
export interface InstallJob {
  id: string;
  tool: ToolId;
  installer: string;
  command: string;
  state: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  detail: string;
}
export interface SetupOverview {
  state: SetupState;
  platform: string;
  checks: ToolCheck[];
  managers: Record<string, boolean>;
  connections: ConnectionCheck[];
  job: InstallJob | null;
}
