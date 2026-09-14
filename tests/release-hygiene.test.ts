import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
// Standalone release tooling deliberately has no npm runtime dependencies.
// @ts-expect-error The release module is native JavaScript.
import * as policy from "../scripts/public-files.mjs";
const { publicFileProblem, publicTextProblem } = policy;

test("source archives retain the application entry point and exclude local-only files", () => {
  const root = mkdtempSync(join(tmpdir(), "workroom-archive-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  try {
    git("init", "-q");
    writeFileSync(
      join(root, ".gitattributes"),
      readFileSync(new URL("../.gitattributes", import.meta.url)),
    );
    for (const path of [
      "client/index.html",
      "server/index.ts",
      "index.html",
      "DESIGN.md",
      "prototypes/compare.html",
      ".data/agent-token",
      "workroom.config.json",
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "synthetic archive fixture\n");
    }
    git("add", "--force", ".");
    const tree = git("write-tree").toString().trim();
    const archive = git("archive", "--format=tar", tree);
    const paths = execFileSync("tar", ["-tf", "-"], {
      input: archive,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.ok(paths.includes("client/index.html"));
    assert.ok(paths.includes("server/index.ts"));
    for (const path of [
      "index.html",
      "DESIGN.md",
      "prototypes/compare.html",
      ".data/agent-token",
      "workroom.config.json",
    ])
      assert.ok(!paths.includes(path), path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication rejects local state, credentials and design artifacts, even if force-added", () => {
  for (const path of [
    ".data/workroom.sqlite",
    ".env",
    ".npmrc",
    "workroom.config.json",
    "workroom.config.personal.json",
    "private.key",
    "archive.tgz",
    "DESIGN.md",
    "PRODUCT.md",
    ".impeccable/context.json",
    "prototypes/compare.html",
    "docs/design-review.md",
    "client/screenshot.png",
    "docs/AGENTS.md",
    "server/.claude/settings.json",
    "node_modules/module/index.ts",
    "dist/index.html",
    "client/../private.ts",
    "/tmp/private.ts",
    "client\\private.ts",
    "client//private.ts",
    "client/main.ts\n",
    "client/main.ts\tprivate.ts",
    "unexpected.json",
  ])
    assert.ok(publicFileProblem(path), path);
});

test("publication accepts the documented source, release tooling and public integration guides", () => {
  for (const path of [
    "README.md",
    "LICENSE",
    "workroom.config.example.json",
    "docs/agents.md",
    "docs/releases/0.1.0.md",
    "client/main.tsx",
    "server/index.ts",
    "tests/release-hygiene.test.ts",
    "scripts/prepare-release.mjs",
    ".github/workflows/ci.yml",
    "public/logos/jira.svg",
  ])
    assert.equal(publicFileProblem(path), undefined, path);
});

test("publication identifies machine paths and local dependencies without forbidding public authorship", () => {
  for (const path of [
    ["", "Users", "person", "work", "repo"].join("/"),
    ["", "home", "person", "repo"].join("/"),
    ["C:", "Users", "person", "repo"].join("\\"),
  ])
    assert.ok(publicTextProblem(path));
  for (const dependency of [
    "file:" + "../private-package",
    "link:" + "/private-package",
  ])
    assert.ok(publicTextProblem(dependency, "package.json"));
  assert.equal(
    publicTextProblem("file:" + "///tmp/example", "tests/urls.test.ts"),
    undefined,
  );
  assert.equal(
    publicTextProblem("Copyright (c) Example Author <author@example.com>"),
    undefined,
  );
  assert.equal(
    publicTextProblem("https://github.com/example/project"),
    undefined,
  );
});
