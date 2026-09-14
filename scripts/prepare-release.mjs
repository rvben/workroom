import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  constants,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publicFileProblem, publicTextProblem } from "./public-files.mjs";
import { smokeRelease } from "./smoke-release.mjs";

const root = process.cwd();
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const filesIn = (directory, prefix = "") =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name),
      relative = prefix + name,
      stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`Unsupported release entry: ${relative}`);
    return stat.isDirectory() ? filesIn(path, relative + "/") : [relative];
  });

if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error(
    "Commit the reviewed source changes before preparing a release.",
  );
const commit = git("rev-parse", "HEAD");
const { version } = JSON.parse(git("show", "HEAD:package.json"));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
  throw new Error("Invalid release version.");
const name = `workroom-${version}`;
const output = resolve(root, ".data/releases", `v${version}`);
if (existsSync(output))
  throw new Error(
    "Release output already exists. Review or remove that local output before rebuilding.",
  );
run(process.execPath, ["scripts/check-public.mjs", "--history"]);
run("gitleaks", ["git", ".", "--redact", "--log-opts=--all"]);
const temporary = mkdtempSync(join(tmpdir(), "workroom-release-"));
try {
  const archive = join(temporary, "source.tar");
  run("git", [
    "archive",
    "--format=tar",
    `--prefix=${name}/`,
    `--output=${archive}`,
    commit,
  ]);
  run("tar", ["-xf", archive, "-C", temporary]);
  const source = join(temporary, name);
  const originals = new Map(
    filesIn(source).map((path) => [path, digest(join(source, path))]),
  );
  if (!originals.has(`docs/releases/${version}.md`))
    throw new Error("Write release notes for this version first.");
  run("npm", ["ci", "--include=dev"], source);
  run("npm", ["audit", "--audit-level=moderate"], source);
  run("npm", ["run", "check"], source);
  await smokeRelease(source);
  rmSync(join(source, "node_modules"), { recursive: true });
  for (const [path, hash] of originals) {
    if (digest(join(source, path)) !== hash)
      throw new Error(`Build changed a source file: ${path}`);
  }
  for (const path of filesIn(source)) {
    const builtAsset =
      /^dist\/(index\.html|assets\/[\w.-]+\.(js|css)|logos\/(?:jira|gitlab|outlook|servicenow)\.svg|logos\/SOURCES\.md)$/.test(
        path,
      );
    if (!originals.has(path) && !builtAsset)
      throw new Error(`Unexpected generated release file: ${path}`);
    if (!builtAsset && publicFileProblem(path))
      throw new Error(`Unreviewed source file: ${path}`);
    if (publicTextProblem(readFileSync(join(source, path), "utf8"), path))
      throw new Error(`Local-only content in release file: ${path}`);
  }
  writeFileSync(
    join(source, "SOURCE.json"),
    JSON.stringify({ name: "workroom", version, commit }, null, 2) + "\n",
  );
  run("gitleaks", ["dir", source, "--redact"]);
  const tarball = join(temporary, `${name}.tar.gz`);
  const tarVersion = execFileSync("tar", ["--version"], { encoding: "utf8" });
  const ownership = tarVersion.includes("bsdtar")
    ? [
        "--uid=0",
        "--gid=0",
        "--uname=root",
        "--gname=root",
        "--no-xattrs",
        "--no-acls",
        "--no-fflags",
      ]
    : tarVersion.includes("GNU tar")
      ? [
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          "--no-xattrs",
          "--no-acls",
        ]
      : undefined;
  if (!ownership) throw new Error("Release packaging requires BSD or GNU tar.");
  run("tar", [...ownership, "-czf", tarball, "-C", temporary, name]);
  const checksum = `${digest(tarball)}  ${name}.tar.gz\n`;
  if (
    git("rev-parse", "HEAD") !== commit ||
    git("status", "--porcelain", "--untracked-files=no")
  )
    throw new Error("Source changed while preparing the release.");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  copyFileSync(
    tarball,
    join(output, `${name}.tar.gz`),
    constants.COPYFILE_EXCL,
  );
  writeFileSync(join(output, "SHA256SUMS"), checksum);
  console.log(
    `Prepared v${version} from ${commit}\nArtifacts: ${output}\nNothing was pushed, tagged or published.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
