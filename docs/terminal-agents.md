# Continue work in your terminal

Workroom can start a foreground Claude Code CLI process on the work machine, associate it with a work session, record selected native hooks and resume its native conversation later. Agent selection is required. This first adapter supports macOS and Linux; it does not install an agent, select a model, change your approval settings or launch from the browser.

The adapter uses documented [CLI session and plugin flags](https://code.claude.com/docs/en/cli-reference), [plugin hooks](https://code.claude.com/docs/en/plugins-reference) and [hook input/output](https://code.claude.com/docs/en/hooks). Codex and Cline can use the [generic reporting contract](agents.md); their native capture adapters are not implemented yet.

## Start from a Jira issue

1. Configure your local clone in Workroom and start work on a live Jira issue. Review the branch/worktree preview.
2. Assign the work session to an agent. Do **not** manually claim it first when using this wrapper.
3. In **Continue in terminal**, explicitly choose Claude Code and copy the command. Run it from the Workroom installation on the authenticated work machine.

```sh
npm run agent -- terminal start SESSION_ID --agent claude
```

The wrapper checks the installed CLI's flags and the recorded Git branch, claims the work, allocates a native conversation UUID and opens Claude interactively in the worktree. The session objective is the initial prompt; the captured context packet and reporting instructions are supplied through the session hook. Use `--prompt /path/to/prompt.txt` to provide your own initial prompt, or `--executable /path/to/claude` for a nonstandard installation. No shell command is constructed from the prompt.

Workroom creates a per-run plugin under its private data directory and passes `--plugin-dir`. It does not edit your repository's `.claude` files or overwrite your existing hooks. Native trust and tool approval prompts remain in Claude. Hooks disabled by configuration or policy will not capture events; Workroom shows that it is waiting for the native hook. This cooperative wrapper is not a sandbox against an agent or person intentionally changing its configuration.

Run from the Workroom installation, or use `npm --silent --prefix "$WORKROOM_ROOT" run agent -- ...`. For a nondefault data directory or port, set `WORKROOM_DATA_DIR` and `WORKROOM_URL` before starting. Keep the same native authentication/configuration environment when resuming. The adapter records the effective `CLAUDE_CONFIG_DIR` and refuses to resume under a different directory. It does not copy provider credentials.

## What reports automatically

The wrapper observes process exit, checks ownership, renews the lease and retries queued events. Its temporary native plugin captures:

| Hook                 | Workroom entry                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| `SessionStart`       | Native conversation opened; supplied session ID must match                 |
| `PostToolUse`        | Bash, Write, Edit or MultiEdit completed; eligible relative file reference |
| `PostToolUseFailure` | One of those tools failed                                                  |
| `Stop`               | Agent turn finished; this is not task completion                           |
| `SessionEnd`         | Native session ended; process exit is checked separately                   |

Hook events are labeled **Adapter-reported**. They are observations supplied by a cooperative native hook, not cryptographically verified execution evidence. Commands, raw tool responses, full transcripts and user prompts are excluded from capture. Bash completion does not imply that tests passed. Other tools, subagents and detached jobs are not a complete observed execution trace.

A `PreToolUse` hook verifies current ownership before tools run. It blocks when the work lease is invalid, Workroom cannot be reached, or the native conversation/worktree changes. It never grants a tool permission. Post-event hooks persist normalized events to the local outbox; the wrapper retries delivery every few seconds. Stable native tool/prompt IDs deduplicate repeated hook capture. When a hook supplies no stable ID, it is recorded as a separate occurrence.

The agent should still explain decisions, findings, blockers and test evidence. Helpers load the active run's private credentials, avoiding credentials in prompts or shell arguments:

```sh
npm run agent -- terminal milestone RUN_ID event.json
npm run agent -- terminal report RUN_ID progress.json
npm run agent -- terminal handoff RUN_ID handoff.json
```

`event.json` follows the milestone schema in the generic guide. `progress.json` can contain `state: "review"`, `summary`, `tests`, `nextAction` and `blocker`. `handoff.json` requires a nonempty `summary`; its default recipient is the human. Reports and handoffs fetch the current version when omitted, and reject stale versions or lost ownership. They do not blindly retry conflicting writes. Handoff revokes the work lease, so the wrapper will stop on its next ownership check. Exit after handing over; do not continue editing.

## Close now, continue later

Exit the native CLI normally. Ctrl+C retains its native meaning and can cancel a turn; it is not guaranteed to exit the conversation. When the process exits and the recorded process group is absent, Workroom marks the execution stopped and releases its claim. It preserves the native conversation reference, reports and worktree. It does not automatically complete the task or publish anything.

Human ownership alone does not establish that a managed process has stopped. MR preparation and publication remain blocked while the worktree has a launching, running or unresolved terminal execution. Exit the terminal and, if needed, use the reconciliation action before preparing the MR.

The terminal prints a continuation command, and Workroom offers **Copy resume command · same conversation**:

```sh
npm run agent -- terminal start SESSION_ID --agent claude --resume NATIVE_SESSION_ID
```

Resume requires a previously observed, stopped conversation belonging to that work session, the original local binding, the same worktree/branch and native configuration directory. It starts a new Workroom reporting attempt with fresh credentials while passing the existing ID to native `--resume`. It never silently substitutes a new conversation or requests a fork. Native session persistence and account access still belong to Claude; a deleted/empty conversation or expired login can make native resume fail. Inspect the terminal's error before retrying.

Do not use `/clear`, `/resume` or switch worktrees inside a managed run. Those change the native identity/context under an existing Workroom claim. Exit and start a separate run instead. Attaching a preexisting unmanaged terminal session, live dashboard-to-terminal attachment and a browser conversation UI are not implemented.

## Recover without losing history

```sh
npm run agent -- terminal runs SESSION_ID
npm run agent -- terminal reconcile RUN_ID
```

An unresolved terminal run continues to reserve its recorded worktree even if the work lease expires. **Check whether execution has stopped** in Workroom, or `terminal reconcile`, checks the recorded wrapper PID and child process group. If either is present, reconciliation refuses to release the lock. A recycled PID can conservatively keep a run blocked. Inspect the original terminal/processes; do not kill an unrelated process just to clear the record.

If ownership renewal fails, the wrapper signals its managed process group to stop and escalates if needed. Missing connectivity is not proof of termination. If final delivery or stop reporting fails, events stay queued and the run requires reconciliation. Independently detached processes can escape the process group; inspect those before editing the same files. The wrapper cannot supervise processes launched outside it.

If a reporting token was lost or revoked, replace it in **Reporting access & recovery**. Stop the old wrapper, set the replacement as `WORKROOM_REPORT_TOKEN`, then run:

```sh
npm run agent -- terminal recover RUN_ID
npm run agent -- flush
```

Recovery verifies the replacement credential, updates that run's private local binding and rebinds its pending events. It does not restore a work lease. Generic outbox holds and inspection still work. Run files, plugin files, packets and credentials live under `WORKROOM_DATA_DIR/terminal/` with private permissions and must never be committed. The server stores credential hashes only; the local wrapper needs the raw run credentials to recover its queued reports. Protect the data directory like any authenticated CLI's state.

## Validation and remaining boundary

The workflow rehearsal uses a synthetic Jira record, the real local API and Git: preview and create a worktree, preserve a dirty original checkout, make a change through an executable native-CLI fixture, run an assertion, report its result, exit and resume the same native ID, hand back to a human and prepare an MR against the exact local commit. It stops at the preview and verifies that agent credentials cannot execute publication. No remote GitLab project or authenticated agent is needed for this test.

Other tests cover fresh attempts, safe process reconciliation, publication blocked by unresolved terminal runs, credential recovery, event deduplication and exclusion of raw input/output. A separate smoke test with the installed Claude CLI validated the generated plugin, completed a model response, exited and resumed the same native ID. The resumed model recalled the earlier synthetic context; both runs delivered native hooks and stopped cleanly. That smoke test used print mode with tools disabled. Interactive terminal behavior and your work machine's trust policies still need a local trial.
