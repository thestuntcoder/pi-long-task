import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generatePlanRevision } from "../src/plan_revision_generation.ts";
import { PersistentTodoPlanStore, StalePlanRevisionError, planTaskReference } from "../src/plan_store.ts";
import { parseTasks } from "../src/todo_parser.ts";

interface TaskSpec {
  title: string;
  stableId?: string;
  done?: boolean;
  status?: string;
}

function todo(specs: readonly TaskSpec[]): string {
  const progress = specs
    .map((spec, index) => `- [${spec.done ? "x" : " "}] TODO ${index + 1} — ${spec.title}`)
    .join("\n");
  const sections = specs
    .map(
      (spec, index) => `## TODO ${index + 1} — ${spec.title}
${spec.stableId ? `\n<!-- pi-long-task-id: ${spec.stableId} -->\n` : ""}
**Goal:** Complete ${spec.title}.

**Status:**
- [${spec.done ? "x" : " "}] ${spec.status ?? `Implement ${spec.title}`}

**Verify:**
- Run focused tests.

**Done when:** The task is complete.`,
    )
    .join("\n\n");
  return `# Pi Long Task TODO

Global instructions:
- Preserve completed work.

## Progress

${progress}

---

${sections}
`;
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-store-"));
try {
  const todoPath = path.join(root, "TODO.md");
  const original = todo([
    { title: "Foundation", stableId: "foundation", done: true },
    { title: "Build API", stableId: "api" },
    { title: "Write docs", stableId: "docs" },
  ]);
  const store = await PersistentTodoPlanStore.create(todoPath, original);
  const base = store.snapshot();
  const revision = await generatePlanRevision({
    currentTodoMarkdown: base.markdown,
    guidance: "Insert a review, move docs before API, and require pagination.",
    revisionId: "revision:mixed",
    taskStates: { "1": "completed", "2": "failed", "3": "pending" },
    relevantResults: [
      {
        taskId: "1",
        status: "done",
        summary: "Foundation output remains valid.",
        outputReferences: ["commit:abc123"],
      },
    ],
    planner: async () =>
      todo([
        { title: "Foundation", stableId: "foundation" },
        // Planner completion is untrusted for new, pending, and modified work.
        { title: "Security review", stableId: "security", done: true },
        { title: "Write docs", stableId: "docs", done: true },
        { title: "Build API", stableId: "api", done: true, status: "Implement API pagination" },
      ]),
  });
  const applied = await store.applyRevision(revision, {
    expectedAuthorityToken: base.authorityToken,
    taskStates: { "1": "completed", "2": "failed", "3": "pending" },
  });

  const persisted = await readFile(todoPath, "utf8");
  assert.equal(persisted, applied.todoMarkdown);
  assert.deepEqual(
    parseTasks(persisted).map((task) => [task.taskId, task.title, task.stableId, task.done]),
    [
      ["1", "Foundation", "foundation", true],
      ["2", "Security review", "security", false],
      ["3", "Write docs", "docs", false],
      ["4", "Build API", "api", false],
    ],
  );
  assert.match(persisted, /## Progress\n\n- \[x\] TODO 1 — Foundation/);
  assert.match(persisted, /## TODO 1 — Foundation[\s\S]*?\*\*Status:\*\*\n- \[x\]/);
  for (const task of parseTasks(persisted).slice(1)) {
    assert.equal(task.progressDone, false, `${task.title} must be unchecked in Progress`);
    assert.deepEqual(task.statusCheckboxes, [false], `${task.title} must be unchecked in its Status section`);
  }
  assert.equal(applied.preservedResults[0]?.identity, "foundation");
  assert.equal(applied.preservedResults[0]?.result.outputReferences?.[0], "commit:abc123");

  // Legacy plans without identity markers acquire reconciled identities without
  // losing completed status during the persistence-time race rebase.
  const legacyPath = path.join(root, "legacy-TODO.md");
  const legacyMarkdown = todo([{ title: "Foundation", done: true }, { title: "Build API" }, { title: "Write docs" }]);
  const legacyStore = await PersistentTodoPlanStore.create(legacyPath, legacyMarkdown);
  const legacyBase = legacyStore.snapshot();
  const legacyRevision = await generatePlanRevision({
    currentTodoMarkdown: legacyBase.markdown,
    guidance: "Move docs before API.",
    revisionId: "revision:legacy",
    planner: async () => todo([{ title: "Foundation" }, { title: "Write docs" }, { title: "Build API" }]),
  });
  await legacyStore.applyRevision(legacyRevision, {
    expectedAuthorityToken: legacyBase.authorityToken,
  });
  assert.deepEqual(
    parseTasks(legacyStore.snapshot().markdown).map((task) => [task.title, task.done, Boolean(task.stableId)]),
    [
      ["Foundation", true, true],
      ["Write docs", false, true],
      ["Build API", false, true],
    ],
  );

  // Reloading from the persisted TODO restores the same identities, ordering,
  // content, and completion state without a separate metadata source of truth.
  const reloaded = await PersistentTodoPlanStore.load(todoPath);
  assert.deepEqual(reloaded.snapshot(), store.snapshot());

  // A status completion queued behind an accepted reorder applies to the latest
  // equivalent identity rather than writing an old full-document snapshot.
  const racePath = path.join(root, "race-TODO.md");
  const raceStore = await PersistentTodoPlanStore.create(racePath, original);
  const raceBase = raceStore.snapshot();
  const docsBefore = parseTasks(raceBase.markdown).find((task) => task.stableId === "docs");
  assert.ok(docsBefore);
  const docsReference = planTaskReference(docsBefore, raceBase.authorityToken);
  const raceRevision = await generatePlanRevision({
    currentTodoMarkdown: raceBase.markdown,
    guidance: "Move docs before API and insert review.",
    revisionId: "revision:race",
    planner: async () =>
      todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Write docs", stableId: "docs" },
        { title: "Security review", stableId: "security" },
        { title: "Build API", stableId: "api" },
      ]),
  });
  let releaseCommit: (() => void) | undefined;
  let reportBeforeCommit: (() => void) | undefined;
  const beforeCommit = new Promise<void>((resolve) => {
    reportBeforeCommit = resolve;
  });
  const commitRelease = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  const applying = raceStore.applyRevision(raceRevision, {
    expectedAuthorityToken: raceBase.authorityToken,
    beforeCommit: async () => {
      reportBeforeCommit?.();
      await commitRelease;
    },
  });
  await beforeCommit;
  const completing = raceStore.completeTask(docsReference);
  releaseCommit?.();
  await applying;
  const completion = await completing;
  assert.equal(completion.applied, true);
  const racedPersisted = await readFile(racePath, "utf8");
  const racedTasks = parseTasks(racedPersisted);
  assert.deepEqual(
    racedTasks.map((task) => [task.title, task.done]),
    [
      ["Foundation", true],
      ["Write docs", true],
      ["Security review", false],
      ["Build API", false],
    ],
  );
  assert.equal(racedTasks[1]?.stableId, "docs");

  // Planner output generated before another structural revision cannot replace
  // the newer accepted plan.
  const staleRevision = await generatePlanRevision({
    currentTodoMarkdown: raceBase.markdown,
    guidance: "Append stale analytics work.",
    revisionId: "revision:stale",
    planner: async () =>
      todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Build API", stableId: "api" },
        { title: "Write docs", stableId: "docs" },
        { title: "Analytics", stableId: "analytics" },
      ]),
  });
  await assert.rejects(
    raceStore.applyRevision(staleRevision, { expectedAuthorityToken: raceBase.authorityToken }),
    StalePlanRevisionError,
  );
  assert.equal(await readFile(racePath, "utf8"), racedPersisted);

  // A worker for replaced work cannot check off its replacement by stale task
  // number or by a reused stable identity with different semantic content.
  const apiBefore = parseTasks(racedPersisted).find((task) => task.stableId === "api");
  assert.ok(apiBefore);
  const apiReference = planTaskReference(apiBefore, raceStore.snapshot().authorityToken);
  const replacementBase = raceStore.snapshot();
  const replacementRevision = await generatePlanRevision({
    currentTodoMarkdown: replacementBase.markdown,
    guidance: "Replace API implementation requirements.",
    revisionId: "revision:replacement",
    activeTask: { taskId: apiBefore.taskId, title: apiBefore.title },
    planner: async () =>
      todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Write docs", stableId: "docs", done: true },
        { title: "Security review", stableId: "security" },
        { title: "Build API", stableId: "api", status: "Replace the API with GraphQL" },
      ]),
  });
  await raceStore.applyRevision(replacementRevision, {
    expectedAuthorityToken: replacementBase.authorityToken,
    runningTask: apiReference,
  });
  const staleCompletion = await raceStore.completeTask(apiReference);
  assert.equal(staleCompletion.applied, false);
  assert.equal(staleCompletion.stale, true);
  assert.equal(parseTasks(staleCompletion.snapshot.markdown).find((task) => task.stableId === "api")?.done, false);

  // An accepted identity replacement also blocks an older worker when the new
  // task happens to retain byte-for-byte equivalent semantic content.
  const identityPath = path.join(root, "identity-TODO.md");
  const identityStore = await PersistentTodoPlanStore.create(identityPath, original);
  const identityBase = identityStore.snapshot();
  const identityApi = parseTasks(identityBase.markdown).find((task) => task.stableId === "api");
  assert.ok(identityApi);
  const oldIdentityReference = planTaskReference(identityApi, identityBase.authorityToken);
  const identityRevision = await generatePlanRevision({
    currentTodoMarkdown: identityBase.markdown,
    guidance: "Replace API work with a separately owned task.",
    revisionId: "revision:identity",
    planner: async () =>
      todo([
        { title: "Foundation", stableId: "foundation" },
        { title: "Build API", stableId: "api-v2" },
        { title: "Write docs", stableId: "docs" },
      ]),
  });
  await identityStore.applyRevision(identityRevision, {
    expectedAuthorityToken: identityBase.authorityToken,
  });
  const oldIdentityCompletion = await identityStore.completeTask(oldIdentityReference);
  assert.equal(oldIdentityCompletion.applied, false);
  assert.equal(oldIdentityCompletion.stale, true);
  assert.equal(parseTasks(oldIdentityCompletion.snapshot.markdown)[1]?.stableId, "api-v2");
  assert.equal(parseTasks(oldIdentityCompletion.snapshot.markdown)[1]?.done, false);
} finally {
  await rm(root, { recursive: true, force: true });
}
