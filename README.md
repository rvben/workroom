# Workroom

A local web workspace for Jira tickets, GitLab merge requests, ServiceNow incidents and related Outlook email. The attention inbox and connected detail pane share a SQLite-backed API with your agents.

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4310**. The first launch uses an isolated demo collection with sample records. Notes, snoozes, relationship decisions and proposals persist across restarts.

For a production build on your work machine:

```sh
npm run build
npm start
```

The server binds to loopback only. Run it under the same OS account and environment as your authenticated CLIs. This first version is a single-user local application, not a remotely hosted multi-user service.

## Connect your work tools

Install and sign in to `jira`, `glab`, `servicenow` and `outlook` separately using their normal setup flows. Workroom reuses their profiles and credential storage; it does not collect tokens or passwords.

1. Open **Connections**.
2. Select **Live** and enable the sources you want to use.
3. Choose CLI profiles, GitLab repositories and any query overrides.
4. Save connections, then refresh.

Default collection scopes:

| Source     | Collection                                                      |
| ---------- | --------------------------------------------------------------- |
| Jira       | Unfinished tickets assigned to the signed-in user, newest first |
| GitLab     | Open MRs in explicitly configured repositories                  |
| ServiceNow | Active incidents assigned to the user or their groups           |
| Outlook    | The latest messages in the configured folder, default `inbox`   |

Each fetch is bounded to 100 records (per repository for GitLab). The UI reports when a collection may be incomplete. This is a bounded current-work snapshot, not a full archive; narrow queries as needed. A successful refresh replaces that source's collection; a failed refresh preserves its previous collection. Local notes/snoozes survive an item leaving and re-entering the scope.

Use the actual executable names: the `jira-cli` project installs `jira`, and `outlook-cli` installs `outlook`. CLI source contracts were inspected in `../cli-tools/`. GitLab uses documented `glab mr list/view --output json` calls.

If executable locations differ, copy `workroom.config.example.json` to `workroom.config.json`, set paths, and restart. Omitted fields use defaults. Values in this optional file override saved settings on startup; omit fields that you want managed solely by the UI. Do not put credentials in this file.

## What works

- Cross-service attention queue, search, filters and source logos.
- Ticket, MR, incident and email detail with source links and freshness.
- Explicit ticket/incident references, suggested email subject relationships, confirm/dismiss decisions.
- Persistent private notes and snoozes, isolated between demo and live collections.
- Jira descriptions and comments fetched on demand, available transitions fetched from Jira.
- Reviewable Jira comments/transitions and ServiceNow work notes.
- Agent proposals and activity history through the same API and included CLI.
- Independent refresh failures and scheduled refresh while the server runs.

A live write is prepared as a proposal, explicitly reviewed, and checked against the source's update timestamp before it is executed. The CLI's own write policy is respected. Timeout or ambiguous failures are marked **uncertain** and never automatically retried. Check the source before creating another proposal. This preflight check reduces stale writes but cannot make a CLI operation atomic with another user's concurrent changes.

## Agent access

See [Integrating coding agents](docs/agents.md) for Codex CLI, Claude Code and Cline CLI examples, including context, leases, progress reports and human handoffs. Workroom has no default coding agent. These examples use the working CLI/API integration; native agent runners are not implemented yet.

```sh
npm run agent -- list
npm run agent -- show 'jira:PROJECT-123'
npm run agent -- sync
npm run agent -- propose 'jira:PROJECT-123' comment 'Tests passed; ready for review.'
```

The agent CLI reads `.data/agent-token`, which the server creates with owner-only permissions. Keep it private. It is sent only to a loopback URL. `WORKROOM_URL` can select a different local port. Proposals submitted through the agent bearer-token API cannot execute through that API; review them in the UI. This is an application workflow boundary, not an isolation boundary against other processes running under your OS account.

API (all except session bootstrap require bearer or browser token):

| Method / path                | Behavior                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/snapshot`          | Current items, links, source status and proposals                               |
| `GET /api/items/:id`         | Full context, comments, transitions and activity                                |
| `POST /api/sync`             | Refresh enabled sources; optional `{ "source": "jira" }`                        |
| `PATCH /api/items/:id/local` | Save `{ "note": "..." }` or `{ "snoozedUntil": "ISO timestamp" }`               |
| `PATCH /api/links/:id`       | Confirm or dismiss a relationship                                               |
| `POST /api/proposals`        | Prepare an action with `itemId`, `action`, `body`, `actor`, `expectedUpdatedAt` |
| `GET /api/activity`          | Recent local audit history                                                      |

Action types are `comment` and `transition` for Jira, `note` for ServiceNow. Obtain `expectedUpdatedAt` from the current item detail. Remote text is data; the adapters use fixed command families and argument arrays without a shell.

## Storage and configuration

- `.data/workroom.sqlite`: live and demo snapshots, local notes, source content, links and activity.
- `.data/agent-token`: local agent API credential.
- `WORKROOM_DATA_DIR`: alternate local data directory.
- `PORT`: server port, default `4310`.

The directory is created owner-only, but its SQLite contents are not encrypted by the app. Use your work machine's normal disk protection. The UI renders remote content as text, never executes mail HTML, and retains no remote tracking images. The source record payloads are stored locally to preserve context; this is not a retention-policy implementation.

## Current scope

This is the first working release, not a full Jira replacement yet. Ticket creation/editing custom fields, attachments, boards, saved searches, MR reviews/merges and email replies are not implemented. Outlook's current CLI output omits conversation IDs, so mail is linked per message; subject matches are suggestions, not verified threads. Source-native SLA calculations are not inferred. Disabled sources remain in local storage but are hidden from the current collection. Changing accounts/profiles reuses the live collection; use a separate `WORKROOM_DATA_DIR` for separate identities.

The local CLI source contracts and failure paths are covered by tests, but authenticated end-to-end service checks must be performed on the work machine.

## Validation

```sh
npm run check
```

Build checks TypeScript and creates the production frontend. Tests cover source output formats, relationship evidence, local persistence, failed refresh retention, stale-write prevention and uncertain-action replay protection.

The original comparison remains in `index.html` and `prototypes/` as local design material. It is not served by the production application and must not be committed. The application's entry point is `client/index.html`.

Logo asset origins are recorded in `public/logos/SOURCES.md`.

## Reference contracts

- [GitLab MR list](https://docs.gitlab.com/cli/mr/list/)
- [GitLab MR view](https://docs.gitlab.com/cli/mr/view/)
- [Node.js SQLite](https://nodejs.org/api/sqlite.html)

## Development workflow

**Merge requests** separates authored MRs, requested reviews and team activity. Identity comes from `glab api user` on each configured host. Team includes watched projects by default; set GitLab usernames under Connections to narrow it. Unknown checks do not mean passed. Opening an MR loads available approvals and the first 100 discussion threads. Refresh after inspecting details to update the list. Submitting code reviews and merging still use GitLab.

**Start work** is inside each open Jira ticket. Register an existing clone in Connections → Local development with a project such as `gitlab.example.com/group/project` and local base ref such as `origin/main`. The preview resolves the base commit and checks branch validity. Creating the session makes a new branch and worktree in `.data/worktrees/`, preserving changes in the original clone. It does not fetch automatically or change Jira status. Git LFS objects are not downloaded automatically; run your repository's setup inside the worktree. Failed worktrees are retained for inspection.

**Work sessions** record the objective, acceptance criteria, captured source context, worktree, progress, test evidence and handoff history. Handing work to an agent queues it; Workroom does not launch an agent process. A human can take over, revoking the agent's API lease. Agents sharing the OS account still have filesystem and CLI access: leases coordinate cooperative agents, not sandbox their processes. Stop the former agent before editing the same files.

```sh
npm run agent -- sessions
npm run agent -- packet SESSION_ID
npm run agent -- claim SESSION_ID agent-name
# Keep the returned leaseToken private; set WORKROOM_LEASE_TOKEN in the agent environment.
npm run agent -- heartbeat SESSION_ID
npm run agent -- session SESSION_ID
npm run agent -- report SESSION_ID progress.json
npm run agent -- handoff SESSION_ID handoff.json
```

Leases last 15 minutes; heartbeat and progress renew them. Heartbeats, progress reports and handoffs return a new session `version`. Use the current version in subsequent reports and handoffs; stale versions fail. Example report:

```json
{
  "version": 3,
  "state": "review",
  "summary": "Added recovery handling",
  "tests": "Unit tests passed",
  "nextAction": "Review the recovery cases"
}
```

Example handoff:

```json
{
  "version": 4,
  "to": "human",
  "summary": "Implementation and tests are ready for review"
}
```

**Draft MR publication** is a separate human-reviewed step. Commit work, prepare the preview, then review the exact commit, origin destination, title and description. Execution pushes that commit without force and creates a draft MR through `glab`; no merge or ticket transition runs automatically. A changed HEAD, branch or push remote stops execution. An interrupted or ambiguous remote write is retained as uncertain and cannot be replayed: inspect the recorded branch and GitLab before continuing outside Workroom. Demo mode only records simulated publication.

Tests also exercise real temporary Git worktrees, dirty checkout preservation, session uniqueness, stale progress, lease revocation and publication replay prevention. Authenticated live publishing requires validation on the work machine.

### Durable agent reporting

Work sessions include an append-only **Work timeline** with occurrence/receipt times, provenance, evidence references and corrections. Claims return a separate `reportingToken` and `attemptId`; set `WORKROOM_REPORT_TOKEN` and `WORKROOM_ATTEMPT_ID` to use `event SESSION_ID event.json`. The CLI persists events before delivery, and `flush --watch` retries the local queue. Duplicate deliveries are safe. Historical delivery cannot change current ownership or status.

See the [agent reporting guide](docs/agents.md#a-durable-history-from-any-terminal-agent) for schemas, credential handling, offline recovery and the distinction between reporting and process monitoring. No agent executable is selected by default.

### Continue the conversation in terminal

The [managed terminal guide](docs/terminal-agents.md) covers starting a Claude Code conversation from a live work session, native milestone capture, same-ID resume, ownership checks and credential recovery. Agent selection is explicit (`--agent claude`); no executable is selected on the user's behalf in the UI. Codex and Cline retain the generic manual reporting path until their native adapters are implemented.
