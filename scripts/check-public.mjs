import { execFileSync } from "node:child_process";
import { publicFileProblem, publicTextProblem } from "./public-files.mjs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const entries = new Map();
for (const record of git("ls-files", "--stage", "-z")
  .split("\0")
  .filter(Boolean)) {
  const boundary = record.indexOf("\t");
  const header = record.slice(0, boundary),
    path = record.slice(boundary + 1);
  const [mode, hash, stage] = header.split(" ");
  if (stage !== "0")
    throw new Error("Resolve the index conflicts before publication.");
  entries.set(`${mode}:${hash}:${path}`, { mode, hash, path });
}
if (process.argv.includes("--history")) {
  const trees = new Set(
    git("log", "--all", "--format=%T").trim().split("\n").filter(Boolean),
  );
  for (const tree of trees) {
    for (const record of git("ls-tree", "-r", "-z", tree)
      .split("\0")
      .filter(Boolean)) {
      const boundary = record.indexOf("\t");
      const header = record.slice(0, boundary),
        path = record.slice(boundary + 1);
      const [mode, , hash] = header.split(" ");
      entries.set(`${mode}:${hash}:${path}`, { mode, hash, path });
    }
  }
}
const problems = new Set();
const blobs = new Map();
for (const { mode, hash, path } of entries.values()) {
  const pathProblem = publicFileProblem(path);
  if (pathProblem) problems.add(`${path}: ${pathProblem}`);
  if (!["100644", "100755"].includes(mode)) {
    problems.add(`${path}: symlinks and submodules are not release inputs`);
    continue;
  }
  if (!blobs.has(hash)) blobs.set(hash, git("cat-file", "blob", hash));
  const textProblem = publicTextProblem(blobs.get(hash), path);
  if (textProblem) problems.add(`${path}: ${textProblem}`);
}
if (problems.size) {
  // Report paths and categories only; never echo potentially private content.
  console.error([...problems].sort().join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Public-source check passed: ${entries.size} file revisions, ${blobs.size} unique blobs. Run Gitleaks separately for secrets.`,
  );
}
