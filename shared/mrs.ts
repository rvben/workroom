import type { WorkItem, MrSignals } from "./types.js";
export function mrSignals(
  item: WorkItem,
  teamMembers: string[] = [],
): MrSignals {
  const r = item.raw;
  const viewer = r._viewer;
  const author = String(
    r.author?.username || r.author?.name || "Unknown author",
  );
  const equal = (a: unknown, b: unknown) =>
    a != null &&
    b != null &&
    String(a).toLowerCase() === String(b).toLowerCase();
  const isUser = (u: any) =>
    !!viewer &&
    (equal(u?.id, viewer.id) || equal(u?.username, viewer.username));
  const mine = isUser(r.author),
    reviewRequested = (r.reviewers || []).some(isUser);
  const pipeline = String(
    r.head_pipeline?.status || r.pipeline?.status || "unknown",
  );
  const draft =
    !!r.draft || !!r.work_in_progress || /^draft:/i.test(item.title);
  const approvals = r._approvals;
  const approved =
    typeof approvals?.approved_by?.length === "number"
      ? approvals.approved_by.length
      : null;
  const approvalsLeft =
    typeof approvals?.approvals_left === "number"
      ? approvals.approvals_left
      : null;
  const discussions = Array.isArray(r._discussions)
    ? r._discussions
        .flatMap((d: any) => d.notes || [])
        .filter((n: any) => n.resolvable && !n.resolved).length
    : null;
  const conflicts =
    r.has_conflicts === true || r.detailed_merge_status === "conflict";
  const sha = String(r.sha || r.diff_refs?.head_sha || "");
  const changedSinceReview =
    !!r._lastReviewedSha && !!sha && r._lastReviewedSha !== sha;
  let reason = "Team activity · no action assigned to you",
    score = 0;
  if (mine) {
    reason = "Your MR is waiting for review";
    score = 35;
    if (draft) {
      reason = "Your draft · continue implementation";
      score = 20;
    }
    if (pipeline === "failed") {
      reason = "Your pipeline failed · fix required";
      score = 85;
    } else if (conflicts) {
      reason = "Your branch has conflicts";
      score = 80;
    } else if ((discussions ?? 0) > 0) {
      reason = "Unresolved feedback on your MR";
      score = 75;
    } else if (approvalsLeft === 0 && !draft) {
      reason = "Approved · ready for your next step";
      score = 65;
    }
  }
  if (reviewRequested && !draft) {
    reason = changedSinceReview
      ? "New commits since your last review"
      : "Your review is requested";
    score = 70;
  }
  if (item.closed) score = 0;
  return {
    mine,
    reviewRequested,
    team: !teamMembers.length || teamMembers.some((u) => equal(u, author)),
    identityKnown: !!viewer,
    author,
    reviewers: (r.reviewers || []).map((u: any) =>
      String(u.username || u.name),
    ),
    repository: String(
      r._repository ||
        r.references?.full?.split("!")[0] ||
        "Unknown repository",
    ),
    pipeline,
    draft,
    approved,
    approvalsLeft,
    discussions,
    conflicts,
    reason,
    score,
    headSha: sha,
    changedSinceReview,
  };
}
export function projectParts(input: string): { host: string; path: string } {
  let value = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (value.startsWith("https://") || value.startsWith("http://")) {
    const u = new URL(value);
    if (u.username || u.password)
      throw new Error("Repository URLs must not contain credentials.");
    return { host: u.host, path: u.pathname.slice(1) };
  }
  const parts = value.split("/");
  if (parts.length < 2 || value.startsWith("-") || /\s|[?#]/.test(value))
    throw new Error("Use group/project or host/group/project.");
  return parts[0].includes(".") ||
    parts[0].includes(":") ||
    parts[0] === "localhost"
    ? { host: parts.shift()!, path: parts.join("/") }
    : { host: "gitlab.com", path: value };
}
