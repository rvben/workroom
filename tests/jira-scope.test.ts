import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJiraQuery,
  parseJiraQuery,
  describeJiraScope,
  DEFAULT_JIRA_SCOPE,
} from "../shared/jira-scope.js";

test("guided Jira filters describe the intended ownership, project and status", () => {
  assert.equal(
    buildJiraQuery(DEFAULT_JIRA_SCOPE),
    "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
  );
  assert.equal(
    buildJiraQuery({ project: "TEAM", owner: "anyone", status: "open" }),
    'project = "TEAM" AND statusCategory != Done ORDER BY updated DESC',
  );
  assert.equal(
    buildJiraQuery({ project: "", owner: "unassigned", status: "done" }),
    "assignee IS EMPTY AND statusCategory = Done ORDER BY updated DESC",
  );
  assert.equal(
    buildJiraQuery({ project: "", owner: "anyone", status: "any" }),
    "ORDER BY updated DESC",
  );
  assert.equal(
    describeJiraScope({ project: "TEAM", owner: "me", status: "open" }, [
      { key: "TEAM", name: "Customer support" },
    ]),
    "Open tickets assigned to you in Customer support, most recently updated first.",
  );
});
test("existing basic queries remain representable without losing their scope", () => {
  assert.deepEqual(
    parseJiraQuery(
      "project = TEAM AND statusCategory != Done ORDER BY updated DESC",
    ),
    { project: "TEAM", owner: "anyone", status: "open" },
  );
  assert.deepEqual(parseJiraQuery(""), DEFAULT_JIRA_SCOPE);
  for (const project of [
    "",
    "TEAM",
    "Research AND Development",
    'x" OR project = "ADMIN',
    "back\\slash",
    " AND ORDER BY ",
  ]) {
    for (const owner of ["me", "anyone", "unassigned"] as const) {
      for (const status of ["open", "done", "any"] as const) {
        const scope = { project: project.trim(), owner, status };
        assert.deepEqual(parseJiraQuery(buildJiraQuery(scope)), scope);
      }
    }
  }
});
test("advanced Jira queries are never silently narrowed or widened into simple filters", () => {
  for (const query of [
    "project = TEAM OR project = ADMIN ORDER BY updated DESC",
    "project = TEAM AND labels = urgent ORDER BY updated DESC",
    "assignee = currentUser() AND assignee IS EMPTY ORDER BY updated DESC",
    "status = Done ORDER BY updated DESC",
    "project = TEAM ORDER BY priority DESC",
    "project = TEAM",
    'project = "unfinished ORDER BY updated DESC',
    "(project = TEAM) ORDER BY updated DESC",
  ])
    assert.equal(parseJiraQuery(query), null, query);
});
