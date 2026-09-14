# Prepare and publish a release

Release preparation is local. No script in this repository pushes a commit, creates a tag, opens a release or publishes an npm package. Publication requires a maintainer's explicit approval of the reviewed commit and artifacts.

## Prepare

1. Update `package.json`, the root package entry in `package-lock.json`, README installation examples and `docs/releases/VERSION.md` together. State known validation limits in the notes.
2. Review the complete source diff. Run `npm run check`, the publication checks and Gitleaks. Inspect staged paths and exclude credentials, machine data and design material before making a signed Conventional Commit.
3. From the clean committed checkout, with Node.js 24+, npm, Git, tar and Gitleaks 8.30.1 available, run:

```sh
npm run release:prepare
```

The command checks the index and full reachable history, scans for secrets, exports exactly HEAD with `git archive`, installs locked dependencies in a temporary directory, audits dependencies, builds and tests, and exercises the production server with fresh demo data. It removes dependencies, rejects unexpected output or source changes, scans the final payload, and creates:

```text
.data/releases/vVERSION/workroom-VERSION.tar.gz
.data/releases/vVERSION/SHA256SUMS
```

`SOURCE.json` inside the archive records the version and source commit. The archive contains public source, license notices and the built frontend. It contains no Node runtime or dependencies; users run `npm ci --include=dev`. The source export never copies untracked or ignored workspace files. Outputs remain ignored and an existing version's output is not overwritten. Network access is needed for npm installation and its vulnerability audit.

Inspect the archive manifest and checksum, then test the extracted archive from a separate directory. The GitHub-generated source zip/tarball also contains only committed source and requires a frontend build. Keep the original artifact and checksum after publication.

## Configure GitHub before publication

Create the approved public repository without generated starter files. Enable private vulnerability reporting, secret scanning and push protection where available. Keep Actions' default token read-only and require approval for workflow runs from outside contributors. The checked-in CI uses GitHub-hosted runners, pinned action commits and no publishing credentials.

Protect `main` with required pull-request review for contributors, stale-review dismissal, required linear history, blocked force pushes and deletions, and these required checks:

- `Build and test (ubuntu-latest)`
- `Build and test (macos-latest)`
- `Repository hygiene`
- `Secrets`
- `Dependency audit`

Keep those protections in place for bots and external contributors. The repository owner may use the administrator exception for a verified fast-forward or squash workflow. Do not give automation an administrator bypass or enable automatic merging. Enable squash/rebase merging and disable merge commits. Review dependency update pull requests normally.

## Publish only after approval

Push the approved commit, wait for every required check on that exact commit, then create and push a signed annotated tag matching the package version. Check the remote tag target before uploading. For the first preview, the release command is:

```sh
gh release create v0.1.0 \
  .data/releases/v0.1.0/workroom-0.1.0.tar.gz \
  .data/releases/v0.1.0/SHA256SUMS \
  --repo rvben/workroom \
  --verify-tag \
  --prerelease \
  --title 'Workroom 0.1.0 — public preview' \
  --notes-file docs/releases/0.1.0.md
```

Recheck that the selected local artifacts still match `SHA256SUMS` and that `SOURCE.json` matches the remote tag. Never upload logs, scan reports, fixture output or the entire data directory. Verify the published download and checksum after release.

If a release attempt only created a brief public tag and no release, artifact, package, checksum or attestation was published, delete and recreate that tag and retry the same version. Once anything was published, retain the tag and use a new patch version. Do not replace a published artifact under an existing version.

## Local updates and backups

Stop managed agent conversations and the Workroom server before updating. Back up the complete private data directory while the server is stopped. Keep both the installation path and data path stable: terminal bindings and worktrees record absolute paths. Never use a source archive as a backup of work sessions. If an update needs rollback, restore the matching application version and its data backup together. Do not commit or upload those backups.
