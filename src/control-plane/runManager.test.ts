import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createInitialRunState, RunStateStore } from "../runState";
import type { WorkflowTask } from "../task";

import { RunManager } from "./runManager";
import { ControlPlaneStore } from "./store";
import {
  ControllableAgentClient,
  FakeGitHubClient,
  FakeWorkspaceManager,
  waitUntil,
} from "./testFakes";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./types";

function writeTaskFixture(
  taskRoot: string,
  taskId: string,
  overrides: Partial<WorkflowTask> = {},
): void {
  const task: WorkflowTask = {
    id: taskId,
    repository: {
      owner: "gunminiho",
      name: "oquestador-fixture",
    },
    workspace: "/tmp/fixture-workspace",
    baseBranch: "main",
    workingBranch: "agent/fake",
    objective: "Do the fixture thing.",
    acceptanceCriteria: ["It works."],
    ...overrides,
  };

  writeFileSync(
    join(taskRoot, `${taskId}.json`),
    JSON.stringify(task),
    "utf8",
  );
}

function setup(
  client = new ControllableAgentClient(),
) {
  const taskRoot = mkdtempSync(
    join(tmpdir(), "cp-tasks-"),
  );
  const runStateStore = new RunStateStore(
    mkdtempSync(
      join(tmpdir(), "cp-runstate-"),
    ),
  );
  const controlPlaneStore =
    new ControlPlaneStore(
      mkdtempSync(
        join(tmpdir(), "cp-registry-"),
      ),
    );
  const github = new FakeGitHubClient();
  const workspaceManager =
    new FakeWorkspaceManager();

  const manager = new RunManager({
    taskRoot,
    runStateStore,
    controlPlaneStore,
    client,
    github,
    workspaceManager,
    defaultAgentProfileId:
      "default-profile",
  });

  return {
    taskRoot,
    runStateStore,
    controlPlaneStore,
    github,
    workspaceManager,
    manager,
    client,
  };
}

async function driveToDone(
  client: ControllableAgentClient,
): Promise<void> {
  await waitUntil(() =>
    client.hasPending(),
  );
  client.finishNext(
    "PREPARATION_RESULT: READY",
  );

  await waitUntil(() =>
    client.hasPending(),
  );
  client.finishNext(
    [
      "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
      "PULL_REQUEST_NUMBER: 1",
    ].join("\n"),
  );

  await waitUntil(() =>
    client.hasPending(),
  );
  client.finishNext(
    "REVIEW_VERDICT: APPROVED",
  );
}

test("startRun rejects an unknown taskId with 404-mapped NotFoundError", async () => {
  const { taskRoot, manager } = setup();
  writeTaskFixture(taskRoot, "known-task");

  await assert.rejects(
    manager.startRun({
      taskId: "does-not-exist",
    }),
    NotFoundError,
  );
});

test("startRun rejects malformed and path-traversal taskId as ValidationError", async () => {
  const { manager } = setup();

  await assert.rejects(
    manager.startRun({
      taskId: "../../etc/passwd",
    }),
    ValidationError,
  );

  await assert.rejects(
    manager.startRun({
      taskId: "with spaces",
    }),
    ValidationError,
  );

  await assert.rejects(
    manager.startRun({ taskId: 123 }),
    ValidationError,
  );
});

test("startRun requires an agentProfileId when no default is configured", async () => {
  const client = new ControllableAgentClient();
  const taskRoot = mkdtempSync(
    join(tmpdir(), "cp-tasks-"),
  );
  writeTaskFixture(taskRoot, "task-a");
  const manager = new RunManager({
    taskRoot,
    runStateStore: new RunStateStore(
      mkdtempSync(
        join(tmpdir(), "cp-runstate-"),
      ),
    ),
    controlPlaneStore:
      new ControlPlaneStore(
        mkdtempSync(
          join(
            tmpdir(),
            "cp-registry-",
          ),
        ),
      ),
    client,
    github: new FakeGitHubClient(),
    workspaceManager:
      new FakeWorkspaceManager(),
  });

  await assert.rejects(
    manager.startRun({
      taskId: "task-a",
    }),
    ValidationError,
  );
});

test("startRun starts a run non-blocking, and it completes to DONE", async () => {
  const { taskRoot, manager, client } =
    setup();
  writeTaskFixture(taskRoot, "task-a");

  const summary =
    await manager.startRun({
      taskId: "task-a",
    });

  assert.equal(summary.status, "RUNNING");
  assert.equal(summary.taskId, "task-a");
  assert.equal(
    summary.agentProfileId,
    "default-profile",
  );

  await driveToDone(client);

  await waitUntil(
    () =>
      manager.getRun(summary.runId)
        .status === "DONE",
  );

  const finalSummary = manager.getRun(
    summary.runId,
  );
  assert.equal(
    finalSummary.pullRequestNumber,
    1,
  );
});

test("startRun accepts an explicit agentProfileId override", async () => {
  const { taskRoot, manager, client } =
    setup();
  writeTaskFixture(taskRoot, "task-a");

  const summary =
    await manager.startRun({
      taskId: "task-a",
      agentProfileId: "claude-profile",
    });

  assert.equal(
    summary.agentProfileId,
    "claude-profile",
  );

  await driveToDone(client);
  await waitUntil(
    () =>
      manager.getRun(summary.runId)
        .status === "DONE",
  );
});

test("startRun rejects a duplicate active run for the same task with a 409-mapped ConflictError", async () => {
  const { taskRoot, manager, client } =
    setup();
  writeTaskFixture(taskRoot, "task-a");

  const first =
    await manager.startRun({
      taskId: "task-a",
    });

  await assert.rejects(
    manager.startRun({
      taskId: "task-a",
    }),
    (error: unknown) => {
      assert.ok(
        error instanceof ConflictError,
      );
      assert.equal(
        (error as ConflictError)
          .existingRunId,
        first.runId,
      );
      return true;
    },
  );

  await driveToDone(client);
  await waitUntil(
    () =>
      manager.getRun(first.runId)
        .status === "DONE",
  );
});

test("pause request stops before the next stage and resume continues it", async () => {
  const { taskRoot, manager, client } =
    setup();
  writeTaskFixture(taskRoot, "task-a");

  const started =
    await manager.startRun({
      taskId: "task-a",
    });

  await waitUntil(() =>
    client.hasPending(),
  );

  const paused = await manager.pauseRun(
    started.runId,
  );
  assert.equal(
    paused.status,
    "PAUSE_REQUESTED",
  );

  // Let PREPARATION finish; the checkpoint before IMPLEMENTING should
  // catch the pause request instead of starting the next stage.
  client.finishNext(
    "PREPARATION_RESULT: READY",
  );

  await waitUntil(
    () =>
      manager.getRun(started.runId)
        .status === "PAUSED",
  );

  assert.equal(client.createCount, 1);

  await assert.rejects(
    manager.pauseRun(started.runId),
    ConflictError,
  );

  const resumed =
    await manager.resumeRun(
      started.runId,
    );
  assert.equal(
    resumed.status,
    "RUNNING",
  );

  // Resuming from IMPLEMENTING (where the pause checkpoint caught it)
  // only needs the implementation and review stages, not preparation
  // again.
  await waitUntil(() =>
    client.hasPending(),
  );
  client.finishNext(
    [
      "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
      "PULL_REQUEST_NUMBER: 1",
    ].join("\n"),
  );

  await waitUntil(() =>
    client.hasPending(),
  );
  client.finishNext(
    "REVIEW_VERDICT: APPROVED",
  );

  await waitUntil(
    () =>
      manager.getRun(started.runId)
        .status === "DONE",
  );
  assert.equal(client.createCount, 3);
});

test("resume is rejected for DONE and CANCELLED runs", async () => {
  const { taskRoot, manager, client } =
    setup();
  writeTaskFixture(taskRoot, "task-a");
  const started =
    await manager.startRun({
      taskId: "task-a",
    });

  await driveToDone(client);
  await waitUntil(
    () =>
      manager.getRun(started.runId)
        .status === "DONE",
  );

  await assert.rejects(
    manager.resumeRun(started.runId),
    ConflictError,
  );

  writeTaskFixture(taskRoot, "task-b");
  const cancelTarget =
    await manager.startRun({
      taskId: "task-b",
    });
  await waitUntil(() =>
    client.hasPending(),
  );
  await manager.cancelRun(
    cancelTarget.runId,
  );
  client.finishNext(
    "PREPARATION_RESULT: READY",
  );
  await waitUntil(
    () =>
      manager.getRun(
        cancelTarget.runId,
      ).status === "CANCELLED",
  );

  await assert.rejects(
    manager.resumeRun(
      cancelTarget.runId,
    ),
    ConflictError,
  );
});

test("cancel request prevents the next stage and finalizes as CANCELLED", async () => {
  const { taskRoot, manager, client } =
    setup();
  writeTaskFixture(taskRoot, "task-a");
  const started =
    await manager.startRun({
      taskId: "task-a",
    });

  await waitUntil(() =>
    client.hasPending(),
  );

  const cancelled =
    await manager.cancelRun(
      started.runId,
    );
  assert.equal(
    cancelled.status,
    "CANCEL_REQUESTED",
  );

  client.finishNext(
    "PREPARATION_RESULT: READY",
  );

  await waitUntil(
    () =>
      manager.getRun(started.runId)
        .status === "CANCELLED",
  );
  assert.equal(client.createCount, 1);

  await assert.rejects(
    manager.cancelRun(started.runId),
    ConflictError,
  );
});

test("cancelling an idle (non-running) run applies immediately", async () => {
  const {
    taskRoot,
    manager,
    runStateStore,
    controlPlaneStore,
  } = setup();
  writeTaskFixture(taskRoot, "task-a");

  runStateStore.save({
    ...createInitialRunState(
      "task-a",
      "BLOCKED",
      null,
    ),
    blockReason: "dirty tree",
  });
  controlPlaneStore.save({
    version: 1,
    runId: "seeded-run",
    taskId: "task-a",
    agentProfileId: "default-profile",
    workspace: "/tmp/fixture-workspace",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const summary = manager.getRun(
    "seeded-run",
  );
  assert.equal(summary.status, "BLOCKED");

  const cancelled =
    await manager.cancelRun(
      "seeded-run",
    );
  assert.equal(
    cancelled.status,
    "CANCELLED",
  );
});

test("getRun and listRuns reject/omit unknown runIds", async () => {
  const { manager } = setup();

  assert.throws(
    () => manager.getRun("missing"),
    NotFoundError,
  );
  assert.deepEqual(
    manager.listRuns(),
    [],
  );
});

test("a restarted process reports an in-flight run as INTERRUPTED until resumed", async () => {
  const taskRoot = mkdtempSync(
    join(tmpdir(), "cp-tasks-"),
  );
  writeTaskFixture(taskRoot, "task-a");
  const runStateDir = mkdtempSync(
    join(tmpdir(), "cp-runstate-"),
  );
  const registryDir = mkdtempSync(
    join(tmpdir(), "cp-registry-"),
  );

  const firstClient =
    new ControllableAgentClient();
  const firstManager = new RunManager({
    taskRoot,
    runStateStore: new RunStateStore(
      runStateDir,
    ),
    controlPlaneStore:
      new ControlPlaneStore(
        registryDir,
      ),
    client: firstClient,
    github: new FakeGitHubClient(),
    workspaceManager:
      new FakeWorkspaceManager(),
    defaultAgentProfileId:
      "default-profile",
  });

  const started =
    await firstManager.startRun({
      taskId: "task-a",
    });
  await waitUntil(() =>
    firstClient.hasPending(),
  );
  assert.equal(
    firstManager.getRun(started.runId)
      .status,
    "RUNNING",
  );

  // Simulate a process restart: a brand-new RunManager, same directories,
  // with no in-memory record of the run that was still executing.
  const secondClient =
    new ControllableAgentClient();
  const secondManager = new RunManager({
    taskRoot,
    runStateStore: new RunStateStore(
      runStateDir,
    ),
    controlPlaneStore:
      new ControlPlaneStore(
        registryDir,
      ),
    client: secondClient,
    github: new FakeGitHubClient(),
    workspaceManager:
      new FakeWorkspaceManager(),
    defaultAgentProfileId:
      "default-profile",
  });

  assert.equal(
    secondManager.getRun(started.runId)
      .status,
    "INTERRUPTED",
  );

  const resumed =
    await secondManager.resumeRun(
      started.runId,
    );
  assert.equal(
    resumed.status,
    "RUNNING",
  );

  await driveToDone(secondClient);
  await waitUntil(
    () =>
      secondManager.getRun(
        started.runId,
      ).status === "DONE",
  );
});

test("a FAILED run with RESOURCE_LIMIT evidence is reported as PAUSED_RESOURCE_LIMIT", async () => {
  const {
    manager,
    runStateStore,
    controlPlaneStore,
  } = setup();

  runStateStore.save({
    ...createInitialRunState(
      "resource-task",
      "IMPLEMENTING",
      null,
    ),
    workflowState: "FAILED",
    failureKind: "RESOURCE_LIMIT",
    failureMessage:
      "hit the usage limit",
    activeStage: "IMPLEMENTATION",
    activeConversationId:
      "11111111-1111-5111-8111-111111111111",
  });
  controlPlaneStore.save({
    version: 1,
    runId: "resource-run",
    taskId: "resource-task",
    agentProfileId: "default-profile",
    workspace: "/tmp/fixture-workspace",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  assert.equal(
    manager.getRun("resource-run")
      .status,
    "PAUSED_RESOURCE_LIMIT",
  );
});
