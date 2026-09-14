# Contributing to Workroom

Use Node.js 24 or newer, npm and Git on macOS or Linux. Install with `npm ci --include=dev`, then run `npm run dev`. Tests use temporary databases, repositories and CLI fixtures; no service credentials are required.

Before submitting a change, run:

```sh
npm run check
npm run smoke:release
git add <reviewed-source-files>
npm run check:public
gitleaks git . --redact --log-opts=--all
gitleaks git . --redact --staged
git diff --cached --name-only
git diff --cached --check
```

The production smoke check requires a built frontend and a checkout without `workroom.config.json`. It uses temporary demo storage, starts a loopback server on a free port and removes its data afterwards. Run it from a clean checkout if your development installation has local configuration.

`check:public` inspects the Git index and reachable history, rejecting unreviewed file locations, local state, machine-specific home paths and local package dependencies. It complements Gitleaks; it is not a general secret detector. A new public file type or top-level location needs a deliberate update to `scripts/public-files.mjs`. Review the actual diff as well: a scanner cannot identify every organisation name, confidential description or personal detail.

Never commit service data, credentials, CLI profiles, local configuration, databases, transcripts, worktrees, design documents, prototype reports or review screenshots. Keep diagnostic examples synthetic. The included author attribution and public maintainer links are intentional.

Use Conventional Commits, such as `fix(outlook): preserve folder pagination`. External contributors and bots submit pull requests and must pass the required checks and review. Maintainer changes may use a checked fast-forward or squash workflow; do not weaken protections for contributors or introduce merge commits.

Changes to CLI contracts should include representative output fixtures and failure cases. UI copy must distinguish verified facts from guesses and partial collections from complete histories. Agent selection remains explicit. External writes must stay reviewable and must not run automatically.

Report security issues privately using the instructions in [SECURITY.md](SECURITY.md).
