export interface TerminalRun {
  id: string;
  sessionId: string;
  attemptId: string;
  agent: "claude";
  nativeSessionId: string;
  worktree: string;
  state: "launching" | "running" | "stopped" | "unknown";
  wrapperPid: number;
  childPid?: number;
  startedAt: string;
  lastSeenAt: string;
  stoppedAt?: string;
  lastHookAt?: string;
  hookConnected: boolean;
  exitCode?: number | null;
  note: string;
}
export interface AdapterDelivery {
  runId: string;
  hook:
    | "SessionStart"
    | "PostToolUse"
    | "PostToolUseFailure"
    | "Stop"
    | "SessionEnd";
  nativeSessionId: string;
}
