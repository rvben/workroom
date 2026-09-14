import { normalize } from "./normalize.js";
import { Store } from "./store.js";
export function seedDemo(store: Store) {
  if (store.get("demo-seeded", false)) return;
  const ago = (minutes: number) =>
    new Date(Date.now() - minutes * 60000).toISOString();
  const records: [any, any][] = [
    [
      "jira",
      {
        id: "248",
        key: "PLAT-248",
        summary: "Prevent duplicate payment retries",
        status: "In Review",
        priority: "High",
        assignee: { displayName: "You" },
        description:
          "Add an idempotency guard so a provider timeout cannot create a second payment attempt. Cover timeout recovery and retries after a process restart.\n\nAcceptance criteria\n• Retries reuse the original idempotency key.\n• A recovery test covers a worker restart.\n• Emit a metric when a duplicate attempt is prevented.",
        updated: ago(12),
        comments: [
          {
            id: "c1",
            author: { displayName: "Platform team" },
            body: "The timeout recovery tests are passing. Ready for a final review.",
            created: ago(30),
          },
        ],
      },
    ],
    [
      "jira",
      {
        id: "231",
        key: "PLAT-231",
        summary: "Rotate reporting service credentials",
        status: "Blocked",
        priority: "Medium",
        assignee: { displayName: "You" },
        description:
          "Rotate the reporting credentials and verify scheduled exports. Production access is pending; the staging change is ready.",
        updated: ago(38),
      },
    ],
    [
      "jira",
      {
        id: "256",
        key: "PLAT-256",
        summary: "Add a deployment health check",
        status: "To Do",
        priority: "Medium",
        assignee: { displayName: "You" },
        description:
          "Check downstream dependencies before a deployment receives traffic. Define the timeout and failure response.",
        updated: ago(60),
      },
    ],
    [
      "jira",
      {
        id: "239",
        key: "PLAT-239",
        summary: "Reduce noise in worker alerts",
        status: "In Progress",
        priority: "Low",
        assignee: { displayName: "You" },
        description:
          "Tune the warning thresholds and group related worker alerts so actionable failures stand out.",
        updated: ago(85),
      },
    ],
    [
      "servicenow",
      {
        sys_id: "demo-incident-218",
        number: "INC004218",
        short_description: "Checkout errors after payment rollout",
        description:
          "Payment authorisation failures increased after the latest rollout. The fix is tracked in PLAT-248. Investigating the provider timeout path.",
        state: { value: "2", display_value: "In Progress" },
        priority: { value: "1", display_value: "1 - Critical" },
        assigned_to: { display_value: "Platform support" },
        sys_updated_on: ago(2),
      },
    ],
    [
      "gitlab",
      {
        id: 184,
        project_id: 10,
        iid: 184,
        title: "PLAT-248: guard retries during provider timeout",
        description:
          "Adds an idempotency guard and recovery tests. Related incident INC004218.",
        state: "opened",
        draft: false,
        author: { name: "Platform team" },
        updated_at: ago(8),
        head_pipeline: { status: "success" },
        _repository: "platform/payments",
      },
    ],
    [
      "gitlab",
      {
        id: 92,
        project_id: 11,
        iid: 92,
        title: "PLAT-231: move reporting to rotated credentials",
        description: "Staging verified. Production access is pending.",
        state: "opened",
        draft: true,
        author: { name: "Platform team" },
        updated_at: ago(45),
        _repository: "platform/reporting",
      },
    ],
    [
      "outlook",
      {
        id: "demo-mail-1",
        subject: "RE: PLAT-248 · checkout incident coordination",
        bodyPreview:
          "The retry guard is ready for review. Can you confirm the mitigation and next update for INC004218?",
        from: { emailAddress: { name: "Incident coordination" } },
        receivedDateTime: ago(6),
        isRead: false,
      },
    ],
    [
      "outlook",
      {
        id: "demo-mail-2",
        subject: "Reporting service credentials — access approval",
        bodyPreview:
          "The production access request is still pending. Who can approve the reporting credentials rotation?",
        from: { emailAddress: { name: "Access team" } },
        receivedDateTime: ago(22),
        isRead: false,
      },
    ],
    [
      "outlook",
      {
        id: "demo-mail-3",
        subject: "PLAT-256 · deployment checklist",
        bodyPreview:
          "We agreed on a five-second timeout and an explicit unhealthy response when the database is unreachable.",
        from: { emailAddress: { name: "Platform team" } },
        receivedDateTime: ago(55),
        isRead: true,
      },
    ],
  ];
  for (const [source, raw] of records)
    store.upsert("demo", normalize(source, raw));
  store.log(
    "demo",
    "jira:PLAT-248",
    "Context collected",
    "Ticket, merge request and incident share explicit references.",
    "Collector",
  );
  const item = store.item("demo", "servicenow:demo-incident-218")!;
  store.createProposal("demo", {
    itemId: item.id,
    action: "note",
    body: "The retry guard is ready for review in payments !184. Validation passed. Deployment has not been approved.",
    expectedUpdatedAt: item.updatedAt,
    actor: "Incident agent",
  });
  store.set("demo-seeded", true);
}

export function upgradeDemoMrs(store: Store) {
  if (store.get("demo-mrs-v2", false)) return;
  const viewer = { id: 1, username: "you", name: "You" };
  for (const i of store.items("demo").filter((i) => i.source === "gitlab")) {
    const mine = i.raw.iid === 184;
    const raw = {
      ...i.raw,
      _viewer: viewer,
      author: mine ? viewer : { id: 2, username: "sam", name: "Sam" },
      reviewers: mine ? [] : [viewer],
      draft: false,
      sha: mine ? "demo184" : "demo92",
      head_pipeline: { status: mine ? "failed" : "success" },
      _approvals: { approved_by: [], approvals_left: 1 },
    };
    store.upsert("demo", normalize("gitlab", raw));
  }
  store.upsert(
    "demo",
    normalize("gitlab", {
      id: 207,
      project_id: 10,
      iid: 207,
      title: "PLAT-256: streamline payment telemetry",
      description: "Reduce noise in the payment dashboards.",
      state: "opened",
      author: { id: 3, username: "alex", name: "Alex" },
      reviewers: [],
      _viewer: viewer,
      _repository: "platform/payments",
      head_pipeline: { status: "success" },
      updated_at: new Date().toISOString(),
    }),
  );
  store.set("demo-mrs-v2", true);
}
