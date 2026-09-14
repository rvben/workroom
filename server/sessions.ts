import {
  eventSchema,
  conversationSchema,
  type WorkEvent,
} from "../shared/events.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  WorkSession,
  StartPlan,
  LocalRepository,
  Mode,
} from "../shared/types.js";
import { Service } from "./service.js";
import {
  git,
  inspectRepository,
  createWorktree,
  suggestBranch,
  type GitRunner,
} from "./git.js";
import { projectParts } from "../shared/mrs.js";
import { safeUrl } from "./normalize.js";
export const startSchema = z.object({
  itemId: z.string(),
  repositoryId: z.string(),
  branch: z.string().min(1).max(150),
  owner: z.enum(["human", "agent"]),
  objective: z.string().trim().min(1).max(15000),
  acceptance: z.string().max(15000),
  baseSha: z.string().optional(),
});
export const reportSchema = z
  .object({
    version: z.number().int(),
    state: z.enum(["working", "blocked", "review", "completed"]).optional(),
    summary: z.string().max(15000).optional(),
    nextAction: z.string().max(5000).optional(),
    blocker: z.string().max(5000).optional(),
    tests: z.string().max(10000).optional(),
  })
  .strict();
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const DEMO_REPOS: LocalRepository[] = [
  {
    id: "demo-payments",
    name: "Payments",
    path: "Demo · no files created",
    project: "platform/payments",
    baseBranch: "main",
  },
  {
    id: "demo-platform",
    name: "Platform",
    path: "Demo · no files created",
    project: "platform/core",
    baseBranch: "main",
  },
];
export class Sessions {
  constructor(
    public service: Service,
    private root = resolve(
      process.env.WORKROOM_DATA_DIR || ".data",
      "worktrees",
    ),
    private runner: GitRunner = git,
  ) {
    for (const mode of ["demo", "live"] as Mode[])
      for (const s of service.store.sessions(mode)) {
        if (s.state === "preparing") {
          s.state = "failed";
          s.steps.push({
            name: "Recovery",
            state: "failed",
            detail:
              "Server restarted during worktree creation. Inspect the recorded worktree and branch; nothing was deleted.",
          });
          this.save(mode, s);
        }
        if (
          s.publication &&
          ["pushing", "creating"].includes(s.publication.state)
        ) {
          s.publication.state = "uncertain";
          s.publication.error =
            "Server restarted during publication. Inspect GitLab before retrying.";
          this.save(mode, s);
        }
      }
  }
  get store() {
    return this.service.store;
  }
  get mode() {
    return this.service.mode;
  }
  repositories() {
    return this.mode === "demo"
      ? DEMO_REPOS
      : this.service.settings.development?.repositories || [];
  }
  get(id: string) {
    const s = this.store.session(this.mode, id);
    if (!s) throw new Error("Work session not found.");
    return s;
  }
  save(mode: Mode, s: WorkSession, hash?: string) {
    const version = s.version;
    s.version++;
    s.updatedAt = new Date().toISOString();
    this.store.updateSession(mode, s, version, hash);
    return s;
  }
  async plan(input: unknown): Promise<StartPlan> {
    const x = startSchema.parse(input);
    const item = this.store.item(this.mode, x.itemId);
    if (!item || item.source !== "jira" || item.closed)
      throw new Error("Choose an open Jira ticket to start work.");
    const repo = this.repositories().find((r) => r.id === x.repositoryId);
    if (!repo) throw new Error("Choose a configured repository.");
    const active = this.store
      .sessions(this.mode)
      .find(
        (s) =>
          s.itemId === x.itemId && !["completed", "failed"].includes(s.state),
      );
    if (active)
      return {
        ...x,
        baseSha: active.baseSha,
        repository: repo,
        warnings: [],
        existingSession: active.id,
      };
    if (this.mode === "demo")
      return {
        ...x,
        baseSha: "demo-base-commit",
        repository: repo,
        warnings: [
          "Demo mode: the session is saved, but no branch or files are created.",
        ],
      };
    const result = await inspectRepository(repo, x.branch, this.runner);
    return {
      ...x,
      baseSha: result.sha,
      repository: { ...repo, path: result.path },
      warnings: result.warnings,
    };
  }
  async start(input: unknown) {
    const mode = this.mode;
    const plan = await this.plan(input);
    if (mode !== this.mode)
      throw new Error("Collection changed. Review again.");
    if (plan.existingSession) return this.get(plan.existingSession);
    if (startSchema.parse(input).baseSha !== plan.baseSha)
      throw new Error("Review the current base commit before starting work.");
    const item = this.store.item(mode, plan.itemId)!;
    const related = new Set(
      this.store
        .links(mode)
        .filter((l) => l.state === "explicit" || l.state === "confirmed")
        .filter((l) => l.from === item.id || l.to === item.id)
        .flatMap((l) => [l.from, l.to]),
    );
    related.add(item.id);
    const s: WorkSession = {
      id: randomUUID(),
      itemId: item.id,
      issueKey: item.key,
      title: item.title,
      repository: plan.repository,
      branch: plan.branch,
      baseSha: plan.baseSha,
      worktree: "",
      owner: plan.owner,
      state: "preparing",
      objective: plan.objective,
      acceptance: plan.acceptance,
      summary: "",
      nextAction:
        plan.owner === "agent"
          ? "An agent can claim this session and begin work."
          : "Open the worktree and start implementation.",
      blocker: "",
      tests: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      leaseOwner: "",
      leaseExpiresAt: "",
      handoffs: [],
      steps: [
        {
          name: "Work session",
          state: "done",
          detail: "Objective and verified source context saved.",
        },
        {
          name: "Branch and worktree",
          state: "pending",
          detail: mode === "demo" ? "Demo only" : plan.branch,
        },
      ],
      context: this.store
        .items(mode)
        .filter((i) => related.has(i.id))
        .map(({ id, key, title, source, url, description }) => ({
          id,
          key,
          title,
          source,
          url,
          description,
        })),
    };
    s.worktree =
      mode === "demo" ? "Demo · no local worktree" : join(this.root, s.id);
    this.store.insertSession(mode, s);
    try {
      if (mode === "live")
        s.worktree = await createWorktree(
          s.repository,
          s.branch,
          s.baseSha,
          s.id,
          this.root,
          this.runner,
        );
      s.state = "ready";
      s.steps[1] = {
        name: "Branch and worktree",
        state: "done",
        detail: s.worktree,
      };
    } catch (e) {
      s.state = "failed";
      s.steps[1] = {
        name: "Branch and worktree",
        state: "failed",
        detail: (e as Error).message,
      };
    }
    this.save(mode, s);
    this.store.log(
      mode,
      s.itemId,
      s.state === "ready" ? "Work session started" : "Worktree setup failed",
      `${s.branch} · ${s.owner === "agent" ? "Ready for agent" : "Human-owned"}`,
    );
    return s;
  }
  claim(id: string, agent: string, conversationInput?: unknown) {
    const conversation =
      conversationInput === undefined
        ? null
        : conversationSchema.parse(conversationInput);
    const s = this.get(id);
    if (
      s.owner !== "agent" ||
      ["preparing", "failed", "completed"].includes(s.state)
    )
      throw new Error("This session is not available for an agent.");
    if (s.leaseExpiresAt && Date.parse(s.leaseExpiresAt) > Date.now())
      throw new Error(
        `Already claimed by ${s.leaseOwner}. Wait for release or lease expiry.`,
      );
    const token = randomBytes(32).toString("hex");
    s.leaseOwner = agent;
    s.leaseExpiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    if (s.state === "ready") s.state = "working";
    const reportingToken = randomBytes(32).toString("hex");
    const attempt = {
      id: randomUUID(),
      sessionId: id,
      actor: agent,
      conversation,
      createdAt: new Date().toISOString(),
      reportHash: digest(reportingToken),
      leaseHash: digest(token),
    };
    this.store.transaction(() => {
      this.save(this.mode, s, digest(token));
      this.store.saveAttempt(this.mode, attempt);
      this.record(
        s,
        "claim",
        "Agent claimed work",
        "Reporting enabled. Process execution is not monitored.",
        agent,
        attempt.id,
      );
    });
    this.store.log(
      this.mode,
      s.itemId,
      "Agent claimed session",
      `15-minute lease for ${agent}`,
      agent,
    );
    return {
      session: s,
      leaseToken: token,
      reportingToken,
      attemptId: attempt.id,
    };
  }
  checkLease(s: WorkSession, token: string) {
    if (
      s.owner !== "agent" ||
      ["completed", "failed", "preparing"].includes(s.state) ||
      !Number.isFinite(Date.parse(s.leaseExpiresAt)) ||
      !token ||
      digest(token) !== this.store.claimHash(this.mode, s.id) ||
      Date.parse(s.leaseExpiresAt) <= Date.now()
    )
      throw new Error(
        "Agent lease is missing or expired. Claim the session before updating it.",
      );
  }
  report(id: string, input: unknown, token: string, isHuman: boolean) {
    const x = reportSchema.parse(input);
    const s = this.get(id);
    this.ensureIdle(s);
    if (s.version !== x.version)
      throw new Error("Session changed. Reload before updating it.");
    if (["preparing", "failed", "completed"].includes(s.state))
      throw new Error("This session cannot be updated in its current state.");
    if (isHuman) {
      if (s.owner === "agent")
        throw new Error("Take over the session before editing it.");
    } else this.checkLease(s, token);
    const next = { ...s, ...x };
    if (next.state === "blocked" && !next.blocker.trim())
      throw new Error("Explain the blocker so the next person can help.");
    if (
      ["review", "completed"].includes(next.state) &&
      (!next.summary.trim() || !next.tests.trim())
    )
      throw new Error(
        "Add an implementation summary and test results before handing work for review or completing it.",
      );
    Object.assign(s, next);
    if (!isHuman)
      s.leaseExpiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    if (s.state === "completed") {
      s.leaseOwner = "";
      s.leaseExpiresAt = "";
    }
    this.store.transaction(() => {
      this.save(this.mode, s, s.state === "completed" ? "" : undefined);
      this.record(
        s,
        "report",
        s.summary || s.nextAction || "Work progress updated",
        `State: ${s.state}\n\nSummary\n${s.summary}\n\nTests (reported)\n${s.tests}\n\nNext action\n${s.nextAction}\n\nBlocker\n${s.blocker}`,
        isHuman ? "You" : s.leaseOwner,
        isHuman
          ? null
          : (this.store.attemptForLease(this.mode, id, digest(token))?.id ??
              null),
      );
    });
    this.store.log(
      this.mode,
      s.itemId,
      "Work progress updated",
      `${s.state}: ${s.summary || s.nextAction}`,
      isHuman ? "You" : s.leaseOwner,
    );
    return s;
  }
  heartbeat(id: string, token: string) {
    const s = this.get(id);
    this.ensureIdle(s);
    this.checkLease(s, token);
    s.leaseExpiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    return this.save(this.mode, s);
  }
  handoff(
    id: string,
    version: number,
    to: "human" | "agent",
    summary: string,
    token: string,
    isHuman: boolean,
  ) {
    const s = this.get(id);
    this.ensureIdle(s);
    if (s.version !== version)
      throw new Error("Session changed. Reload before handing it off.");
    if (!summary.trim()) throw new Error("Add a handoff note.");
    if (["preparing", "completed", "failed"].includes(s.state))
      throw new Error("Session is not available for handoff.");
    if (!isHuman) {
      this.checkLease(s, token);
      if (to !== "human") throw new Error("Agents hand work back to a person.");
      if (s.state !== "blocked" && (!s.summary.trim() || !s.tests.trim()))
        throw new Error(
          "Record implementation summary and test results before handing off.",
        );
    }
    const from = s.leaseOwner || (s.owner === "human" ? "You" : "Agent queue");
    s.handoffs.push({ at: new Date().toISOString(), from, to, summary });
    s.owner = to;
    s.leaseOwner = "";
    s.leaseExpiresAt = "";
    s.nextAction = summary;
    if (s.state !== "blocked") s.state = to === "human" ? "review" : "ready";
    this.store.transaction(() => {
      this.save(this.mode, s, "");
      this.record(
        s,
        "handoff",
        `Work handed to ${to === "human" ? "a person" : "the agent queue"}`,
        summary,
        from,
        isHuman
          ? null
          : (this.store.attemptForLease(this.mode, id, digest(token))?.id ??
              null),
      );
    });
    this.store.log(this.mode, s.itemId, "Work handed off", summary, from);
    return s;
  }
  record(
    s: WorkSession,
    kind: WorkEvent["kind"],
    summary: string,
    detail: string,
    actor: string,
    attemptId: string | null,
  ) {
    const now = new Date().toISOString();
    return this.store.appendEvent(this.mode, {
      id: randomUUID(),
      sessionId: s.id,
      attemptId,
      kind,
      summary,
      detail,
      actor,
      occurredAt: now,
      receivedAt: now,
      evidence: [],
      source: "workroom",
      historical: false,
      conversation: attemptId
        ? (this.store.attempt(this.mode, attemptId)?.conversation ?? null)
        : null,
    });
  }
  reportingAccess(id: string) {
    this.get(id);
    return this.store
      .attempts(this.mode, id)
      .map(({ reportHash, leaseHash, ...attempt }) => ({
        ...attempt,
        credentialVersion: attempt.credentialVersion ?? 1,
        status: attempt.revokedAt ? ("revoked" as const) : ("active" as const),
      }));
  }
  reportingAttempt(id: string, attemptId: string, token: string) {
    this.get(id);
    const attempt = this.store.attempt(this.mode, attemptId);
    if (
      !attempt ||
      attempt.sessionId !== id ||
      attempt.revokedAt ||
      !token ||
      attempt.reportHash !== digest(token)
    )
      throw new Error(
        "Reporting credential is revoked or does not match this session and attempt.",
      );
    return attempt;
  }
  manageReporting(
    id: string,
    attemptId: string,
    action: "rotate" | "revoke",
    version: number,
  ) {
    const s = this.get(id);
    return this.store.transaction(() => {
      const attempt = this.store.attempt(this.mode, attemptId);
      if (!attempt || attempt.sessionId !== id)
        throw new Error("Reporting attempt not found.");
      if ((attempt.credentialVersion ?? 1) !== version)
        throw new Error(
          "Reporting access changed. Reload before trying again.",
        );
      if (action === "revoke" && attempt.revokedAt)
        throw new Error("Reporting access is already revoked.");
      const reportingToken =
        action === "rotate" ? randomBytes(32).toString("hex") : undefined;
      const now = new Date().toISOString();
      attempt.reportHash = reportingToken ? digest(reportingToken) : "";
      attempt.credentialVersion = version + 1;
      attempt.revokedAt = action === "revoke" ? now : "";
      if (action === "rotate") attempt.rotatedAt = now;
      this.store.updateAttempt(this.mode, attempt);
      this.record(
        s,
        "credential",
        action === "rotate"
          ? "Reporting credential replaced"
          : "Reporting access revoked",
        `Attempt ${attempt.id}. ${action === "rotate" ? "Previous credential no longer accepted. Rebind pending events with the replacement." : "Existing history preserved. New event delivery is disabled for this attempt."} Work ownership is unchanged.`,
        "You",
        attempt.id,
      );
      return {
        access: this.reportingAccess(id).find((a) => a.id === attemptId)!,
        ...(reportingToken ? { reportingToken } : {}),
      };
    });
  }
  events(id: string, after = 0, limit = 100, before?: number) {
    this.get(id);
    return this.store.events(this.mode, id, after, limit, before);
  }
  event(id: string, input: unknown, token: string) {
    const x = eventSchema.parse(input);
    const s = this.get(id);
    const attempt = this.reportingAttempt(id, x.attemptId, token);
    const old = this.store.event(this.mode, x.id);
    if (old) {
      const original = eventSchema.parse(oldEventInput(old));
      if (
        old.sessionId !== id ||
        old.source !== "agent" ||
        JSON.stringify(original) !== JSON.stringify(x)
      )
        throw new Error(
          "Event ID already exists with different content. Use a new correction event.",
        );
      return { event: old, duplicate: true };
    }
    if (Date.parse(x.occurredAt) > Date.now() + 5 * 60000)
      throw new Error(
        "Event time is more than five minutes in the future. Check the reporting clock.",
      );
    if (x.corrects) {
      const original = this.store.event(this.mode, x.corrects);
      if (
        !original ||
        original.sessionId !== id ||
        original.attemptId !== x.attemptId ||
        original.source !== "agent"
      )
        throw new Error(
          "Correction must reference an existing agent event in the same attempt.",
        );
    }
    const historical =
      s.owner !== "agent" ||
      Date.parse(s.leaseExpiresAt) <= Date.now() ||
      this.store.claimHash(this.mode, id) !== attempt.leaseHash;
    // Reporting credentials only append history. They never renew a lease or mutate current state.
    const event = this.store.appendEvent(this.mode, {
      ...x,
      sessionId: id,
      actor: attempt.actor,
      receivedAt: new Date().toISOString(),
      source: "agent",
      conversation: attempt.conversation,
      historical,
    });
    return { event, duplicate: false };
  }
  packet(id: string) {
    const s = this.get(id);
    return {
      session: s,
      instructions: `Work only in the recorded worktree. Claim before editing. Renew the 15-minute lease while working. Record findings, decisions, evidence and blockers with event; the local outbox retains undelivered events. Run flush --watch for delivery retries. Events do not renew leases or update status. Record summary, tests and next action with report. Handoff to a human for review. Do not push, publish, merge, or change upstream tickets without an explicit reviewed action.`,
      context: s.context,
    };
  }
  ensureIdle(s: WorkSession) {
    if (["pushing", "creating"].includes(s.publication?.state || ""))
      throw new Error("Wait for publication to finish.");
  }
  async preparePublish(id: string, title: string, description: string) {
    const mode = this.mode;
    const s = this.get(id);
    if (
      s.owner !== "human" ||
      !["working", "review", "ready", "blocked"].includes(s.state)
    )
      throw new Error("Take ownership of this session before publishing.");
    if (
      s.publication &&
      ["pushing", "creating", "published", "uncertain"].includes(
        s.publication.state,
      )
    )
      throw new Error(
        "Publication already exists or needs reconciliation. Check its recorded result.",
      );
    let sha = "demo-commit",
      remote = "Demo · no push";
    if (mode === "live") {
      if (!this.service.settings.connectors.gitlab.enabled)
        throw new Error("Enable GitLab before preparing publication.");
      const branch = await this.runner(s.worktree, [
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);
      if (branch !== s.branch)
        throw new Error("The worktree is on a different branch.");
      if (await this.runner(s.worktree, ["status", "--porcelain"]))
        throw new Error(
          "Commit or set aside worktree changes before preparing an MR.",
        );
      sha = await this.runner(s.worktree, ["rev-parse", "HEAD"]);
      if (
        Number(
          await this.runner(s.worktree, [
            "rev-list",
            "--count",
            `${s.baseSha}..HEAD`,
          ]),
        ) < 1
      )
        throw new Error("Create at least one commit before publishing.");
      remote = await this.runner(s.worktree, [
        "remote",
        "get-url",
        "--push",
        "origin",
      ]);
      const clean = remote.replace(/^git@([^:]+):/, "https://$1/");
      const got = projectParts(clean),
        want = projectParts(s.repository.project);
      if (got.host !== want.host || got.path !== want.path)
        throw new Error(
          "The origin push URL does not match the configured GitLab project.",
        );
    }
    s.publication = {
      state: "prepared",
      sha,
      title: title.startsWith("Draft:") ? title : `Draft: ${title}`,
      description,
      url: "",
      error: "",
      remote,
    };
    if (mode !== this.mode)
      throw new Error("Collection changed. Review again.");
    return this.save(mode, s);
  }
  async publish(id: string, version: number) {
    const mode = this.mode;
    const s = this.get(id);
    const p = s.publication;
    if (
      !p ||
      p.state !== "prepared" ||
      s.version !== version ||
      s.owner !== "human"
    )
      throw new Error("Prepare and review this publication again.");
    let attemptedWrite = false;
    p.state = "pushing";
    this.save(mode, s);
    try {
      if (mode === "live") {
        if ((await this.runner(s.worktree, ["rev-parse", "HEAD"])) !== p.sha)
          throw new Error("HEAD changed after the publication preview.");
        if (
          (await this.runner(s.worktree, [
            "remote",
            "get-url",
            "--push",
            "origin",
          ])) !== p.remote
        )
          throw new Error("Push remote changed after review.");
        if (
          (await this.runner(s.worktree, [
            "symbolic-ref",
            "--short",
            "HEAD",
          ])) !== s.branch
        )
          throw new Error("Branch changed after review.");
        attemptedWrite = true;
        // The exact reviewed commit is pushed; never force push.
        await this.runner(s.worktree, [
          "push",
          "--porcelain",
          "origin",
          `${p.sha}:refs/heads/${s.branch}`,
        ]);
        p.state = "creating";
        this.save(mode, s);
        const project = projectParts(s.repository.project);
        const result = await this.service
          .adapter("gitlab")
          .call(
            [
              "api",
              `projects/${encodeURIComponent(project.path)}/merge_requests`,
              "--hostname",
              project.host,
              "--method",
              "POST",
              "--raw-field",
              `source_branch=${s.branch}`,
              "--raw-field",
              `target_branch=${s.repository.baseBranch.replace(/^origin\//, "")}`,
              "--raw-field",
              `title=${p.title}`,
              "--raw-field",
              `description=${p.description}`,
            ],
            true,
          );
        p.url = safeUrl(result.web_url);
        if (!p.url)
          throw new Error(
            "GitLab did not return an MR URL. Check the project before retrying.",
          );
      }
      p.state = "published";
      p.error =
        mode === "demo" ? "Demo publication recorded; nothing was pushed." : "";
      this.store.log(mode, s.itemId, "Draft MR published", p.url || p.error);
    } catch (e) {
      p.state = attemptedWrite ? "uncertain" : "failed";
      p.error = attemptedWrite
        ? `${(e as Error).message} Check the branch and GitLab MR before any retry.`
        : (e as Error).message;
    }
    return this.save(mode, s);
  }
}

function oldEventInput(e: WorkEvent) {
  return {
    id: e.id,
    attemptId: e.attemptId,
    occurredAt: e.occurredAt,
    kind: e.kind,
    summary: e.summary,
    detail: e.detail,
    evidence: e.evidence,
    ...(e.corrects ? { corrects: e.corrects } : {}),
  };
}
