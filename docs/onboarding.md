# Set up your work machine

Open **Connections → Guided setup**. The setup invitation also appears on the attention page until you dismiss or complete it. You can explore the demo, leave setup at any point and return to your saved choices.

1. **Your services:** choose Jira, GitLab, ServiceNow or Outlook. Start with one; the others can wait.
2. **Install & connect:** check the CLIs on the machine running Workroom, install missing tools, sign in from your terminal and verify each connection. A successful check shows a small preview of the selected collection. Zero results are distinguished from authentication failure.
3. **Your agents:** explicitly choose Codex, Claude Code, Cline or none. Add existing local repositories if you want isolated worktrees. Repository verification checks the root and base commit without creating a branch or fetching.
4. **Open your workspace:** review the verified sources and agent choices. Only recently verified sources are enabled. Opening the inbox refreshes the live collection; unsuccessful sources retain their last cached data and display their error.

## Install tools

Workroom checks executables and required command flags, plus the package managers available to its server. A tool being installed does **not** establish that its account, model provider or organisation policy permits access.

Missing tools offer reviewed package-manager commands. **Install on this machine** downloads and executes the selected package and its dependencies as the server's OS user. The command is fixed by Workroom's catalog; the browser cannot supply arbitrary commands or package names. Installation does not request administrator access. You can also copy the command into your own terminal.

| Tool | Supported guided installation | Maintainer instructions |
| --- | --- | --- |
| Jira | `uv tool install --no-build jira-cli-rs` or `cargo install jira-cli --locked` | [jira-cli](https://github.com/rvben/jira-cli) |
| GitLab | `brew install glab` | [GitLab CLI](https://docs.gitlab.com/cli/), [Homebrew formula](https://formulae.brew.sh/formula/glab) |
| ServiceNow | `pipx install servicenow-cli` or `cargo install servicenow-cli --locked` | [servicenow-cli](https://github.com/rvben/servicenow-cli) |
| Outlook | `uv tool install --no-build outlook-cli-rs` or `cargo install outlook-cli --locked` | [outlook-cli](https://github.com/rvben/outlook-cli) |
| Codex | `npm install --global @openai/codex` | [Codex CLI](https://developers.openai.com/codex/cli) |
| Claude Code | `brew install --cask claude-code` on macOS | [Claude Code quickstart](https://code.claude.com/docs/en/quickstart) |
| Cline | `npm install --global cline` | [Cline installation](https://docs.cline.bot/getting-started/installing-cline) |

Guided installation supports macOS and Linux, including WSL. Other platforms and methods link to the maintainer's instructions. Package managers must already be installed. Cargo builds need Rust and native build tools. The catalog uses current registry releases; it is not a lockfile for CLI versions. Existing installations may be updated by the chosen package manager. Workroom does not install agents merely because they are selected.

Only one package installation runs at a time. Its status survives page reloads. A server restart marks an unfinished installation as interrupted; it is never automatically retried, and a recorded process that is still present blocks another install. A recycled PID may conservatively retain that block. Inspect the package manager before retrying. Independently detached installers are outside this process check. Failed or timed-out installations may leave partial files. For detailed package-manager diagnostics, run the displayed command in your terminal. Raw installation output is not retained or sent to the browser.

Standard user install directories (`~/.local/bin`, `~/.cargo/bin`) and Homebrew locations are checked in addition to the server's PATH. Existing PATH entries take priority. For a custom executable, set its connector path in the ignored `workroom.config.json` and restart Workroom. Agent launch paths can also be supplied to the terminal wrapper with `--executable`.

## Sign in and verify the right scope

Credentials are entered in each CLI's own terminal/browser flow, never into Workroom. Use the profile shown in setup. Newer Jira CLIs provide guided `init`; older versions print setup instructions. GitLab sign-in uses the site URL shown in its setup panel. Add and authenticate projects from each host you want to collect. ServiceNow includes the entered instance URL in its sign-in command.

Jira and ServiceNow site URLs build source links; ServiceNow also uses its URL for initial sign-in. CLI profiles determine the account and service queried. Review the returned items to confirm that you chose the intended account and collection. Jira explicitly verifies the authenticated user before searching, so an anonymous empty result cannot pass the connection check. GitLab verifies the account on each configured host before collecting MRs. ServiceNow and Outlook verify their collection commands using the CLI's authentication.

Jira starts with guided filters: **Project**, **Whose work?** and **Status**. The default is open work assigned to you. After signing in, choose **Load my projects** to select a project by name, or enter the prefix from a ticket key. For a test project with unassigned tickets, choose **Everyone, including unassigned**. A sentence below the filters explains what will appear. **Advanced: edit JQL** supports custom queries. Existing custom queries remain intact; switching an unsupported custom query to guided filters requires explicitly replacing it. Project discovery is read-only and does not mark the connection verified.

GitLab starts with your site URL and **Find my projects**. Search your project memberships, load more results, and select up to 20 projects. You can also paste a project URL, including projects on another host. Your MRs, review requests and team activity are collected from those projects. Team activity includes all authors unless you narrow team usernames in local development settings. Project discovery explicitly uses [GitLab’s read-only project list](https://docs.gitlab.com/api/projects/#list-all-projects) through [`glab api`](https://docs.gitlab.com/cli/api/); it never creates a project or requests additional access.

ServiceNow offers **Whose incidents?**, **Status** and **Priority**. It starts with active incidents assigned to you or your groups, using the CLI’s existing personal-queue query. Critical and high priorities use the standard numeric values 1 and 2. **Advanced: edit incident query** preserves instance-specific encoded queries. Replacing an unsupported custom query requires an explicit choice. Preview the returned incidents to confirm your instance’s assignment and active-state rules.

Outlook starts with **Inbox** and recent messages. Choose another familiar folder, or use **Browse my folders** to navigate named folders, subfolders and additional pages. Desktop folder IDs are supported without requiring users to copy them. Add an optional topic or ticket key to narrow the collection. Microsoft 365 searches sender, subject and message text; Outlook Desktop searches literal sender and subject text. **Advanced: search and folder settings** preserves custom searches and folder IDs. Workroom collects individual messages and suggests links to tickets and incidents; it does not guarantee a complete email thread. Folder discovery does not read message bodies or mark mail as read.

Collection is bounded. A success with zero items means the scope returned no work, not that every possible item was collected. Discovery and installation checks do not enable a connection; each selected source still needs **Save & verify connection**.

Checks expire after ten minutes and are invalidated when their draft changes. They must be repeated after a server restart. Configuration drafts and dismissals persist locally. Saving a setup draft does not change the active collection; the final action applies the verified choices. Concurrent edits are rejected for review. Stop managed terminal runs before changing live connections.

## Agents and worktrees

No agent is selected or launched by default. Saved choices appear in work sessions. Claude Code currently supports the [managed terminal workflow](terminal-agents.md), including native hook capture and same-conversation resume. Codex and Cline support the [generic reporting contract](agents.md); selecting them does not imply native capture support. Provider login, model selection and approval policy remain in the agent's own CLI.

Register existing local clones and a locally available base ref for worktrees. Setup does not clone, fetch, push, publish, modify upstream issues or start an agent task. Once connected, open a Jira ticket and choose **Start work** to review the actual branch and worktree plan.

Setup state and installation status are stored in the private local database. API tokens, browser cookies and package-manager output are excluded from setup responses. Installation, configuration and connection-check endpoints require the browser session; agent bearer credentials cannot call them.
