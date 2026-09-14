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
import { git } from "../server/git.js";
const exec = promisify(execFile);
test(
  "Jira context to worktree, native resume, test report, human handoff and MR preview",
  { timeout: 180000 },
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
    await git(tree, ["init", "-b", "main"]);
    writeFileSync(join(tree, "answer.cjs"), "module.exports = 41;\n");
    await git(tree, ["add", "answer.cjs"]);
    const commit = (cwd: string, message: string) =>
      git(cwd, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message,
      ]);
    await commit(tree, "test: initial fixture");
    await git(tree, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/group/trial.git",
    ]);
    writeFileSync(join(tree, "answer.cjs"), "original dirty checkout\n");
    const store = new Store(join(data, "workroom.sqlite")),
      service = new Service(store, undefined, "/no-terminal-test-config");
    const item = store
      .items("demo")
      .find((i) => i.source === "jira" && !i.closed)!;
    store.upsert("live", item);
    store.set("settings", {
      ...service.settings,
      mode: "live",
      refreshMinutes: 120,
      connectors: {
        ...service.settings.connectors,
        gitlab: { ...service.settings.connectors.gitlab, enabled: true },
      },
      development: {
        repositories: [
          {
            id: "trial",
            name: "Trial",
            path: tree,
            project: "example.invalid/group/trial",
            baseBranch: "main",
          },
        ],
        teamMembers: [],
      },
    });
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
const marker=path.join(process.env.WORKROOM_DATA_DIR,'native-state.json');let state={id,turns:0};if(resume){state=JSON.parse(fs.readFileSync(marker,'utf8'));if(state.id!==id)process.exit(4);}state.turns++;fs.writeFileSync(marker,JSON.stringify(state));
const runId=path.basename(path.dirname(plugin));
function workroom(command,body){
 const file=path.join(process.env.WORKROOM_DATA_DIR,command+'.json');fs.writeFileSync(file,JSON.stringify(body));
 const result=spawnSync(process.execPath,['--import','tsx',path.join(process.env.WORKROOM_ROOT,'server/cli.ts'),'terminal',command,runId,file],{cwd:process.env.WORKROOM_ROOT,env:process.env,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr);
}
for(const event of ['SessionStart','PreToolUse','PostToolUse','Stop','SessionEnd']){
 const raw={session_id:id,cwd:process.cwd(),hook_event_name:event,tool_name:'Bash',tool_use_id:'tool-'+state.turns,prompt_id:'prompt-'+state.turns,tool_input:{command:'echo fixture-private-input'},tool_response:{stdout:'fixture-private-output'}};
 const result=spawnSync('/bin/sh',['-c',hooks[event][0].hooks[0].command],{input:JSON.stringify(raw),encoding:'utf8'});
 if(result.status!==0){process.stderr.write(result.stderr);process.exit(5);}
 if(event==='PreToolUse'){
  if(!resume)fs.writeFileSync(path.join(process.cwd(),'answer.cjs'),'module.exports = 42;\\n');
  const check=spawnSync(process.execPath,['-e',"require('node:assert/strict').equal(require('./answer.cjs'),42)"],{cwd:process.cwd()});
  if(check.status!==0)process.exit(6);
  workroom('report',{state:resume?'review':'working',summary:resume?'Verified the resumed change':'Fixed answer',tests:'Node assertion passed: answer equals 42',nextAction:resume?'Human review':'Resume and review'});
 }
 if(event==='Stop' && resume)workroom('handoff',{summary:'Change and test evidence ready for human review'});
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
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let serverError = "";
    server.stderr.on("data", (chunk) => {
      serverError = (serverError + chunk.toString()).slice(-4000);
    });
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(
            process.execPath,
            ["--import", "tsx", "server/cli.ts", ...args],
            { env, timeout: 60000 },
          )
        ).stdout,
      );
    try {
      let ready = false;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        assert.equal(
          server.exitCode,
          null,
          serverError || "Trial server exited before startup",
        );
        try {
          if (
            (
              await fetch(env.WORKROOM_URL + "/api/session", {
                signal: AbortSignal.timeout(1000),
              })
            ).ok
          ) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        ready,
        serverError || "Trial server did not become ready within 60 seconds",
      );
      const { token } = await (
        await fetch(env.WORKROOM_URL + "/api/session")
      ).json();
      const ui = async (path: string, body: unknown) => {
        const response = await fetch(env.WORKROOM_URL + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-workroom-token": token,
          },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        assert.equal(response.ok, true, JSON.stringify(result));
        return result;
      };
      const plan = await ui("/api/work/plan", {
        itemId: item.id,
        repositoryId: "trial",
        branch: "test/terminal",
        owner: "agent",
        objective: "Correct the answer to 42",
        acceptance: "Node assertion passes after resume",
      });
      assert.ok(plan.warnings.some((w: string) => w.includes("changes")));
      const s = await ui("/api/work/start", plan);
      assert.equal(s.state, "ready");
      assert.equal(await git(tree, ["branch", "--show-current"]), "main");
      assert.equal(
        await git(s.worktree, ["branch", "--show-current"]),
        "test/terminal",
      );
      assert.equal(
        readFileSync(join(tree, "answer.cjs"), "utf8"),
        "original dirty checkout\n",
      );
      assert.equal((await cli("packet", s.id)).context[0].key, item.key);
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
        JSON.parse(readFileSync(join(data, "native-state.json"), "utf8")).turns,
        2,
      );
      const handedOff = await cli("session", s.id);
      assert.equal(handedOff.leaseExpiresAt, "");
      assert.equal(handedOff.owner, "human");
      assert.equal(handedOff.state, "review");
      assert.equal(handedOff.tests, "Node assertion passed: answer equals 42");
      assert.equal(second.run.state, "stopped");
      assert.equal(second.pendingEvents, 0);
      assert.equal(
        readFileSync(join(s.worktree, "answer.cjs"), "utf8"),
        "module.exports = 42;\n",
      );
      await git(s.worktree, ["add", "answer.cjs"]);
      await commit(s.worktree, "fix: return the correct answer");
      const prepared = await ui(
        `/api/work/sessions/${s.id}/prepare-publication`,
        { title: "Correct the answer", description: handedOff.tests },
      );
      assert.equal(prepared.publication.state, "prepared");
      assert.equal(
        prepared.publication.sha,
        await git(s.worktree, ["rev-parse", "HEAD"]),
      );
      assert.equal(prepared.publication.url, "");
      // The rehearsal stops at review; the agent cannot execute publication.
      const denied = await fetch(
        env.WORKROOM_URL + `/api/work/sessions/${s.id}/publish`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization:
              "Bearer " + readFileSync(join(data, "agent-token"), "utf8"),
          },
          body: JSON.stringify({ version: prepared.version }),
        },
      );
      assert.equal(denied.status, 403);
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
