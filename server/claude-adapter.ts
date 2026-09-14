import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import { eventSchema, type EventInput } from "../shared/events.js";
import type { AdapterDelivery } from "../shared/terminal.js";
export const hookInput = z
  .object({
    session_id: z.string(),
    cwd: z.string(),
    hook_event_name: z.string(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    prompt_id: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional(),
  })
  .passthrough();
export interface HookBinding {
  nativeSessionId: string;
  attemptId: string;
  worktree: string;
  id: string;
}
export function canonicalPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
export function mapClaudeHook(
  binding: HookBinding,
  raw: unknown,
): { event: EventInput; delivery: AdapterDelivery; key: string } | null {
  const x = hookInput.parse(raw);
  if (x.session_id !== binding.nativeSessionId)
    throw new Error(
      "Conversation identity changed. Exit and start a separate Workroom run.",
    );
  if (canonicalPath(x.cwd) !== canonicalPath(binding.worktree))
    throw new Error("Hook is outside the recorded worktree.");
  const hooks = [
    "SessionStart",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SessionEnd",
  ] as const;
  if (!hooks.includes(x.hook_event_name as any)) return null;
  const hook = x.hook_event_name as AdapterDelivery["hook"];
  const tool = ["Bash", "Write", "Edit", "MultiEdit"].includes(
    x.tool_name || "",
  )
    ? x.tool_name!
    : "Tool";
  if (
    (hook === "PostToolUse" || hook === "PostToolUseFailure") &&
    tool === "Tool"
  )
    return null;
  const titles = {
    SessionStart: "Native conversation opened",
    PostToolUse: `${tool} tool completed`,
    PostToolUseFailure: `${tool} tool failed`,
    Stop: "Agent turn finished",
    SessionEnd: "Native session ended",
  };
  const evidence: EventInput["evidence"] = [];
  // Do not copy commands, prompts, responses, transcripts or credentials into Workroom.
  if (
    ["Write", "Edit", "MultiEdit"].includes(tool) &&
    typeof x.tool_input?.file_path === "string"
  ) {
    const ref = relative(
      binding.worktree,
      resolve(binding.worktree, x.tool_input.file_path),
    );
    if (ref && !ref.startsWith("..") && !isAbsolute(ref))
      evidence.push({
        kind: "file",
        label: "File named by native hook",
        reference: ref.slice(0, 2000),
      });
  }
  let detail =
    "Captured from the native CLI hook. This does not mark the work complete.";
  if (hook === "PostToolUse" || hook === "PostToolUseFailure")
    detail =
      "Tool outcome reported by the native hook. Test success is not inferred; the agent should submit a milestone report with test evidence.";
  const event = eventSchema.parse({
    id: randomUUID(),
    attemptId: binding.attemptId,
    occurredAt: new Date().toISOString(),
    kind:
      hook === "Stop" ? "turn" : hook.startsWith("Post") ? "tool" : "session",
    summary: titles[hook],
    detail,
    evidence,
  });
  const identity = x.tool_use_id || x.prompt_id || randomUUID();
  return {
    event,
    delivery: {
      runId: binding.id,
      hook,
      nativeSessionId: binding.nativeSessionId,
    },
    key: `${binding.id}:${hook}:${identity}`,
  };
}
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function claudeArgs(
  pluginDir: string,
  nativeId: string,
  resume: boolean,
  prompt?: string,
) {
  return [
    "--plugin-dir",
    pluginDir,
    resume ? "--resume" : "--session-id",
    nativeId,
    ...(prompt ? ["--", prompt] : []),
  ];
}
export function claudeHooks(command: string) {
  return {
    hooks: Object.fromEntries(
      [
        "SessionStart",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
        "SessionEnd",
      ].map((name) => [
        name,
        [
          {
            ...(name.startsWith("Post")
              ? { matcher: "Bash|Write|Edit|MultiEdit" }
              : {}),
            hooks: [
              {
                type: "command",
                command: command + " " + name,
                timeout: name === "PreToolUse" ? 12 : 10,
              },
            ],
          },
        ],
      ]),
    ),
  };
}
