import { execFile } from "node:child_process";
import { realpathSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { LocalRepository } from "../shared/types.js";
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;
export const git: GitRunner = (cwd, args) =>
  new Promise((done, fail) => {
    const proc = execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
      {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (e, out, err) =>
        e
          ? fail(
              new Error(
                e.killed
                  ? "Git timed out. Inspect the worktree before trying again."
                  : err
                      .trim()
                      .replace(/https?:\/\/[^\s@]+@/g, "https://[redacted]@") ||
                      "Git operation failed.",
              ),
            )
          : done(out.trim()),
    );
    proc.stdin?.end();
  });
export function suggestBranch(key: string, title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 65)
    .replace(/-$/, "");
  return `${key}/${slug || "work"}`;
}
export async function inspectRepository(
  repo: LocalRepository,
  branch: string,
  runner = git,
) {
  if (!existsSync(repo.path))
    throw new Error(
      "Local checkout not found. Configure an existing Git repository.",
    );
  const path = realpathSync(repo.path);
  const root = await runner(path, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(root) !== path)
    throw new Error("Use the repository root, not a subdirectory.");
  if (!branch || branch.startsWith("-") || branch === "HEAD")
    throw new Error("Choose a valid feature branch name.");
  await runner(path, ["check-ref-format", "--branch", branch]);
  if (!repo.baseBranch || repo.baseBranch.startsWith("-"))
    throw new Error("Configure a base branch.");
  const sha = await runner(path, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${repo.baseBranch}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40,64}$/.test(sha))
    throw new Error("Base branch did not resolve to a commit.");
  const existing = await runner(path, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/heads/${branch}`,
  ]);
  if (existing)
    throw new Error("That branch already exists. Choose a new branch name.");
  const dirty = await runner(path, ["status", "--porcelain"]);
  return {
    sha,
    path,
    warnings: [
      `Uses the locally available ${repo.baseBranch}; no automatic fetch.`,
      ...(dirty
        ? [
            "Your existing checkout has changes. They remain in place; the new worktree starts from the base commit.",
          ]
        : []),
    ],
  };
}
export async function createWorktree(
  repo: LocalRepository,
  branch: string,
  sha: string,
  sessionId: string,
  root: string,
  runner = git,
) {
  const inspected = await inspectRepository(repo, branch, runner);
  if (inspected.sha !== sha)
    throw new Error("Base branch changed. Review Start work again.");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(realpathSync(root), sessionId);
  if (existsSync(target)) throw new Error("Worktree location already exists.");
  // Disable hooks and automatic checkout. Files are materialized separately with automatic LFS downloads disabled.
  await runner(inspected.path, [
    "worktree",
    "add",
    "--no-checkout",
    "-b",
    branch,
    target,
    sha,
  ]);
  try {
    await runner(target, [
      "-c",
      "filter.lfs.required=false",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "reset",
      "--hard",
      sha,
    ]);
  } catch (e) {
    throw new Error(
      `Branch created at ${target}, but checkout failed. Inspect it before retrying. ${(e as Error).message}`,
    );
  }
  return target;
}
