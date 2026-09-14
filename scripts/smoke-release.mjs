import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function smokeRelease(root = process.cwd()) {
  assert.ok(
    !existsSync(join(root, "workroom.config.json")),
    "Smoke checks require a checkout without local configuration.",
  );
  assert.ok(
    existsSync(join(root, "dist/index.html")),
    "Build the frontend first.",
  );
  const data = mkdtempSync(join(tmpdir(), "workroom-release-smoke-"));
  const reservation = createServer();
  let child;
  try {
    await new Promise((done, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", done);
    });
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const base = `http://127.0.0.1:${port}`;
    let startupError;
    child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts", "--production"],
      {
        cwd: root,
        env: { ...process.env, WORKROOM_DATA_DIR: data, PORT: String(port) },
        stdio: "ignore",
      },
    );
    child.on("error", (error) => {
      startupError = error;
    });
    let bootstrap;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      assert.equal(
        child.exitCode,
        null,
        "Production server exited during startup.",
      );
      try {
        const response = await fetch(`${base}/api/session`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          bootstrap = await response.json();
          break;
        }
      } catch {}
      await pause(100);
    }
    assert.ok(bootstrap?.token, "Production server did not become ready.");
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="root"/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(
      (match) => match[1],
    );
    assert.ok(
      assets.some((asset) => asset.endsWith(".js")),
      "Missing built JavaScript.",
    );
    for (const asset of [
      ...assets,
      ...["jira", "gitlab", "outlook", "servicenow"].map(
        (name) => `/logos/${name}.svg`,
      ),
    ]) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200, asset);
      assert.doesNotMatch(
        response.headers.get("content-type") || "",
        /text\/html/,
        asset,
      );
    }
    assert.equal((await fetch(`${base}/api/snapshot`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/session`, {
          headers: { Origin: "https://example.invalid" },
        })
      ).status,
      403,
    );
    const headers = { "x-workroom-token": bootstrap.token };
    const response = await fetch(`${base}/api/snapshot`, { headers });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.mode, "demo");
    assert.deepEqual(
      [...new Set(snapshot.items.map((item) => item.source))].sort(),
      ["gitlab", "jira", "outlook", "servicenow"],
    );
    assert.equal((await fetch(`${base}/api/setup`, { headers })).status, 200);
    console.log(
      "Release smoke passed: production assets, four demo sources, guided setup and local API authentication.",
    );
  } finally {
    if (reservation.listening) reservation.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 4000;
      while (
        child.exitCode === null &&
        child.signalCode === null &&
        Date.now() < deadline
      )
        await pause(50);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((done) => child.once("exit", done));
      }
    }
    rmSync(data, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await smokeRelease();
}
