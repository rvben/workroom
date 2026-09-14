import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIncidentQuery,
  parseIncidentQuery,
  DEFAULT_INCIDENT_SCOPE,
  describeIncidentScope,
  normalizeGitLabHost,
  addGitLabProject,
  simpleMailSearch,
  sameGitLabProject,
} from "../shared/backend-scopes.js";
import { projectParts } from "../shared/mrs.js";

test("guided incident choices preserve the existing personal queue and support priority limits", () => {
  assert.equal(
    buildIncidentQuery(DEFAULT_INCIDENT_SCOPE),
    "active=true^assigned_to=javascript:gs.getUserID()^ORassignment_group=javascript:getMyGroups()^ORDERBYDESCsys_updated_on",
  );
  assert.equal(
    buildIncidentQuery({ owner: "me", status: "active", priority: "critical" }),
    "active=true^assigned_to=javascript:gs.getUserID()^priority=1^ORDERBYDESCsys_updated_on",
  );
  assert.equal(
    buildIncidentQuery({
      owner: "unassigned",
      status: "inactive",
      priority: "high",
    }),
    "active=false^assigned_toISEMPTY^priorityIN1,2^ORDERBYDESCsys_updated_on",
  );
  assert.equal(
    buildIncidentQuery({ owner: "anyone", status: "any", priority: "any" }),
    "ORDERBYDESCsys_updated_on",
  );
  assert.match(
    describeIncidentScope({
      owner: "groups",
      status: "active",
      priority: "high",
    }),
    /Active incidents assigned to your groups with critical or high priority/,
  );
});
test("custom incident queries are never silently replaced by guided defaults", () => {
  assert.deepEqual(parseIncidentQuery(""), DEFAULT_INCIDENT_SCOPE);
  for (const owner of [
    "mine-and-groups",
    "me",
    "groups",
    "unassigned",
    "anyone",
  ] as const)
    for (const status of ["active", "inactive", "any"] as const)
      for (const priority of ["any", "critical", "high"] as const) {
        const scope = { owner, status, priority };
        assert.deepEqual(parseIncidentQuery(buildIncidentQuery(scope)), scope);
      }
  for (const q of [
    "priority=1",
    "active=true^NQpriority=1",
    "assignment_group=team-id^ORDERBYDESCsys_updated_on",
    "active=true^category=network^ORDERBYDESCsys_updated_on",
  ])
    assert.equal(parseIncidentQuery(q), null);
});
test("project URLs keep nested namespaces and the intended self-managed host", () => {
  assert.equal(
    normalizeGitLabHost(" https://gitlab.example.com/ "),
    "gitlab.example.com",
  );
  assert.deepEqual(
    addGitLabProject("team/subgroup/repo", "gitlab.example.com"),
    {
      host: "gitlab.example.com",
      project: "gitlab.example.com/team/subgroup/repo",
    },
  );
  assert.deepEqual(
    addGitLabProject(
      "https://other.example.com/team/repo.git",
      "gitlab.example.com",
    ),
    { host: "other.example.com", project: "other.example.com/team/repo" },
  );
  assert.deepEqual(
    projectParts(addGitLabProject("team/repo", "gitlab").project),
    { host: "gitlab", path: "team/repo" },
  );
  for (const host of [
    "https://user:secret@gitlab.example.com",
    "https://gitlab.example.com/team",
    "https://gitlab.example.com/?token=secret",
    "--help",
    "file:///tmp",
  ])
    assert.throws(() => normalizeGitLabHost(host));
  for (const path of [
    "project-only",
    "team/../repo",
    "team/repo?token=secret",
    "team/repo/-/merge_requests",
  ])
    assert.throws(() => addGitLabProject(path, "gitlab.example.com"));
});
test("plain email topics and existing advanced search remain distinguishable", () => {
  for (const q of ["", "service outage", "TEAM-123", "mail@example.com"])
    assert.equal(simpleMailSearch(q), true);
  for (const q of [
    'subject:"service outage"',
    "from:person@example.com",
    "subject:change AND hasAttachments:true",
  ])
    assert.equal(simpleMailSearch(q), false);
});

test("existing project URLs and short paths match discoveries without duplicate selections", () => {
  assert.equal(
    sameGitLabProject("team/project", "gitlab.com/team/project"),
    true,
  );
  assert.equal(
    sameGitLabProject(
      "https://gitlab.example.com/team/project.git",
      "gitlab.example.com/team/project",
    ),
    true,
  );
  assert.equal(
    sameGitLabProject(
      "gitlab.example.com/team/project",
      "other.example.com/team/project",
    ),
    false,
  );
});
