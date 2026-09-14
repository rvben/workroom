import { mrSignals } from "../shared/mrs.js";
import { createHash } from "node:crypto";
import type { Source, WorkItem, Link } from "../shared/types.js";
export function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).join("\n");
  return text(
    v.display_value ??
      v.name ??
      v.displayName ??
      v.value ??
      v.text ??
      v.content ??
      "",
  );
}
// Convert message bodies to display text only. The client never renders this as HTML.
export function mailText(body: any, preview: unknown): string {
  if (!body?.content) return text(preview);
  const content = text(body.content);
  if (String(body.contentType).toLowerCase() !== "html") return content;
  return content
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*br\s*\/?\s*>|<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[entity] || entity,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function safeUrl(v: unknown): string {
  try {
    const u = new URL(String(v));
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "";
  } catch {
    return "";
  }
}
export function listPayload(source: Source, data: any): any[] {
  const rows = Array.isArray(data)
    ? data
    : source === "servicenow"
      ? data?.result
      : data?.items;
  if (!Array.isArray(rows))
    throw new Error(
      "Unexpected collection format; existing snapshot retained.",
    );
  return rows;
}
export function normalize(
  source: Source,
  r: any,
  baseUrl = "",
  observedAt = new Date().toISOString(),
): WorkItem {
  const field = r.fields || r;
  const key =
    source === "jira"
      ? text(r.key)
      : source === "servicenow"
        ? text(r.number)
        : source === "gitlab"
          ? `!${r.iid}`
          : text(r.id);
  const identifier =
    source === "gitlab"
      ? `${r._host ? r._host + ":" : ""}${r.project_id}:${r.iid}`
      : source === "jira"
        ? key
        : source === "servicenow"
          ? text(r.sys_id) || key
          : text(r.id);
  if (!identifier || !key || key === "!undefined")
    throw new Error("A source record is missing its identifier.");
  const title =
    text(field.summary ?? r.short_description ?? r.title ?? r.subject) ||
    "(Untitled)";
  const status =
    source === "outlook"
      ? r.isRead
        ? "Read"
        : "Unread"
      : text(field.status ?? r.state);
  const priority = text(field.priority ?? r.importance);
  const closed =
    source === "outlook"
      ? !!r.isRead
      : source === "servicenow"
        ? ["6", "7", "8"].includes(text(r.state?.value ?? r.state)) ||
          /resolved|closed|cancel/i.test(status)
        : /^(done|closed|resolved|merged|cancelled)$/i.test(status);
  let reason =
    source === "jira"
      ? "Ticket in your configured Jira query"
      : source === "servicenow"
        ? "Incident in your configured attention scope"
        : source === "gitlab"
          ? "Open merge request in a configured repository"
          : "Email in your configured folder";
  let score =
    source === "servicenow"
      ? 70
      : source === "gitlab"
        ? 55
        : source === "jira"
          ? 40
          : 20;
  if (source === "servicenow" && /^(1|2)\b|critical|high/i.test(priority)) {
    score = 100;
    reason = "High-priority incident needs attention";
  }
  if (source === "jira" && /block/i.test(status)) {
    score = 65;
    reason = "Blocked ticket needs a decision";
  }
  if (source === "gitlab" && r.draft) {
    score = 30;
    reason = "Draft merge request · work in progress";
  }
  if (source === "outlook" && !r.isRead) {
    score = 25;
    reason = "Unread related email";
  }
  if (closed) score = 0;
  const url =
    safeUrl(r.url ?? r.web_url ?? r.webLink) ||
    (source === "servicenow" && baseUrl
      ? safeUrl(
          `${baseUrl.replace(/\/$/, "")}/nav_to.do?uri=incident.do%3Fsys_id%3D${encodeURIComponent(text(r.sys_id))}`,
        )
      : "");
  const item: WorkItem = {
    id: `${source}:${identifier}`,
    key,
    source,
    kind:
      source === "jira"
        ? "ticket"
        : source === "gitlab"
          ? "mr"
          : source === "servicenow"
            ? "incident"
            : "email",
    title,
    status,
    priority,
    closed,
    reason,
    score,
    url,
    description:
      source === "outlook"
        ? mailText(r.body, r.bodyPreview)
        : text(r.description ?? field.description),
    assignee: text(
      field.assignee ?? r.assigned_to ?? r.author ?? r.from?.emailAddress,
    ),
    updatedAt: text(
      r.updated ??
        field.updated ??
        r.updated_at ??
        r.sys_updated_on ??
        r.receivedDateTime,
    ),
    observedAt,
    raw: r,
  };
  if (source === "gitlab") {
    const signal = mrSignals(item);
    item.score = signal.score;
    item.reason = signal.reason;
  }
  return item;
}
const stop = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "your",
  "re",
  "fw",
  "fwd",
  "update",
  "request",
]);
function words(s: string) {
  return new Set(
    s
      .toLowerCase()
      .match(/[a-z]{4,}/g)
      ?.filter((w) => !stop.has(w)) || [],
  );
}
export function buildLinks(items: WorkItem[]): Link[] {
  const links: Link[] = [];
  const roots = items.filter(
    (i) => i.source === "jira" || i.source === "servicenow",
  );
  for (const root of roots)
    for (const item of items) {
      if (item.id === root.id) continue;

      const corpus = `${item.title}\n${item.description}\n${JSON.stringify(item.raw.issueLinks || item.raw.issuelinks || [])}`;
      const escaped = root.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let evidence = "",
        state: Link["state"] = "explicit";
      if (new RegExp(`(?<![A-Z0-9])${escaped}(?![A-Z0-9])`, "i").test(corpus))
        evidence = `Explicit ${root.key} reference in source text`;
      else if (root.url && corpus.includes(root.url))
        evidence = "Explicit source URL";
      else if (item.source === "outlook") {
        const a = words(root.title),
          b = words(item.title);
        const shared = [...a].filter((w) => b.has(w));
        if (shared.length >= 2) {
          evidence = `Shared subject terms: ${shared.join(", ")}. Verify before relying on this link.`;
          state = "suggested";
        }
      }
      if (evidence) {
        const pair = [root.id, item.id].sort();
        const id = createHash("sha256")
          .update(pair.join("|"))
          .digest("hex")
          .slice(0, 24);
        if (!links.some((l) => l.id === id))
          links.push({ id, from: pair[0], to: pair[1], evidence, state });
      }
    }
  return links;
}
