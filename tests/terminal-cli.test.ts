import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../server/store.js";
import { Service } from "../server/service.js";
import { Sessions } from "../server/sessions.js";
const exec = promisify(execFile);
test(
  "terminal wrapper runs hooks, persists native identity across resume and releases ownership",
  { timeout: 40000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "workroom-native-fixture-")),
      data = join(root, "data"),
      tree = join(root, "worktree");
    mkdirSync(data);
    mkdirSync(tree);
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((r) => listener.close(() => r()));
    await exec("git", ["init", "-b", "test/terminal"], { cwd: tree });
    const store = new Store(join(data, "workroom.sqlite")),
      service = new Service(store, undefined, "/no-terminal-test-config"),
      sessions = new Sessions(service);
    const item = store
      .items("demo")
      .find((i) => i.source === "jira" && !i.closed)!;
    const s = await sessions.start(
      await sessions.plan({
        itemId: item.id,
        repositoryId: "demo-payments",
        branch: "test/terminal",
        owner: "agent",
        objective: "Exercise the adapter",
        acceptance: "Same native session twice",
      }),
    );
    s.worktree = tree;
    store.insertSession("live", s);
    store.upsert("live", item);
    store.set("settings", { ...service.settings, mode: "live" });
    store.close();
    writeFileSync(join(data, "agent-token"), randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
    const fake = join(root, "native-cli");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2);if(args.includes('--help')){console.log('--plugin-dir --session-id --resume');process.exit(0);}
const plugin=args[args.indexOf('--plugin-dir')+1];const resume=args.includes('--resume');const id=args[args.indexOf(resume?'--resume':'--session-id')+1];
const hooks=JSON.parse(fs.readFileSync(path.join(plugin,'hooks/hooks.json'),'utf8')).hooks;
const marker=path.join(process.cwd(),'native-state.json');let state={id,turns:0};if(resume){state=JSON.parse(fs.readFileSync(marker,'utf8'));if(state.id!==id)process.exit(4);}state.turns++;fs.writeFileSync(marker,JSON.stringify(state));
for(const event of ['SessionStart','PreToolUse','PostToolUse','Stop','SessionEnd']){
 const raw={session_id:id,cwd:process.cwd(),hook_event_name:event,tool_name:'Bash',tool_use_id:'tool-'+state.turns,prompt_id:'prompt-'+state.turns,tool_input:{command:'echo fixture-private-input'},tool_response:{stdout:'fixture-private-output'}};
 const result=spawnSync('/bin/sh',['-c',hooks[event][0].hooks[0].command],{input:JSON.stringify(raw),encoding:'utf8'});
 if(result.status!==0){process.stderr.write(result.stderr);process.exit(5);}
}
`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      WORKROOM_DATA_DIR: data,
      WORKROOM_URL: `http://127.0.0.1:${port}`,
      PORT: String(port),
      CLAUDE_CONFIG_DIR: join(root, "native-config"),
    };
    const server = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts", "--production"],
      { env, stdio: "ignore" },
    );
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(
            process.execPath,
            ["--import", "tsx", "server/cli.ts", ...args],
            { env, timeout: 15000 },
          )
        ).stdout,
      );
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(env.WORKROOM_URL + "/api/session")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      const first = await cli(
        "terminal",
        "start",
        s.id,
        "--agent",
        "claude",
        "--executable",
        fake,
      );
      assert.equal(first.run.state, "stopped");
      assert.equal(first.run.hookConnected, true);
      assert.equal(first.pendingEvents, 0);
      const second = await cli(
        "terminal",
        "start",
        s.id,
        "--agent",
        "claude",
        "--resume",
        first.run.nativeSessionId,
        "--executable",
        fake,
      );
      assert.equal(second.run.nativeSessionId, first.run.nativeSessionId);
      assert.notEqual(second.run.attemptId, first.run.attemptId);
      assert.equal(
        JSON.parse(readFileSync(join(tree, "native-state.json"), "utf8")).turns,
        2,
      );
      assert.equal((await cli("session", s.id)).leaseExpiresAt, "");
      const page = await cli("events", s.id);
      assert.equal(
        page.events.filter((e: any) => e.source === "adapter").length,
        8,
      );
      assert.equal(
        JSON.stringify(page).includes("fixture-private-input"),
        false,
      );
      assert.equal(
        JSON.stringify(page).includes("fixture-private-output"),
        false,
      );
    } finally {
      if (server.exitCode === null) {
        const stopped = new Promise<void>((r) =>
          server.once("exit", () => r()),
        );
        server.kill("SIGTERM");
        await stopped;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
