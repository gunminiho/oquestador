import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialRunState,
  RunStateStore,
} from "./runState";

function temporaryStore(): RunStateStore {
  return new RunStateStore(
    mkdtempSync(
      join(
        tmpdir(),
        "run-state-test-",
      ),
    ),
  );
}

test(
  "creates, saves, and loads initial RunState",
  () => {
    const store =
      temporaryStore();

    const state =
      createInitialRunState(
        "task-1",
        "PREPARING",
        null,
        new Date(
          "2026-01-01T00:00:00.000Z",
        ),
      );

    store.save(state);

    const loaded =
      store.load("task-1");

    assert.equal(
      loaded?.version,
      3,
    );
    assert.equal(
      loaded?.taskId,
      "task-1",
    );
    assert.equal(
      loaded?.workflowState,
      "PREPARING",
    );
    assert.equal(
      loaded?.preparationAttempt,
      0,
    );
    assert.equal(
      loaded?.implementationCycle,
      0,
    );
    assert.equal(
      loaded?.pullRequestNumber,
      null,
    );
    assert.equal(
      loaded?.reviewAttempt,
      0,
    );
    assert.equal(
      loaded?.reviewHeadSha,
      null,
    );
    assert.equal(
      loaded?.approvedHeadSha,
      null,
    );
    assert.equal(
      loaded?.mergeCommitSha,
      null,
    );
    assert.equal(
      loaded?.reviewerFeedback,
      null,
    );
    assert.equal(
      loaded?.blockReason,
      null,
    );
    assert.equal(
      loaded?.failureKind,
      null,
    );
    assert.equal(
      loaded?.activeConversationId,
      null,
    );
  },
);

test(
  "preserves implementationCycle, pullRequestNumber, and reviewerFeedback",
  () => {
    const store =
      temporaryStore();

    const state = {
      ...createInitialRunState(
        "task-2",
        "REVIEWING",
        47,
      ),
      implementationCycle: 3,
      reviewerFeedback:
        "full reviewer feedback",
      activeStage:
        "REVIEW" as const,
      activeConversationId:
        "review-1",
      reviewConversationId:
        "review-1",
      lastReviewerVerdict:
        "CHANGES_REQUESTED" as const,
    };

    store.save(state);

    const loaded =
      store.load("task-2");

    assert.equal(
      loaded?.implementationCycle,
      3,
    );
    assert.equal(
      loaded?.pullRequestNumber,
      47,
    );
    assert.equal(
      loaded?.reviewerFeedback,
      "full reviewer feedback",
    );
  },
);

test(
  "preserves BLOCKED reason as first-class state",
  () => {
    const store =
      temporaryStore();

    store.save({
      ...createInitialRunState(
        "blocked-task",
        "BLOCKED",
        8,
      ),
      blockReason:
        "working tree is dirty",
    });

    const loaded =
      store.load(
        "blocked-task",
      );

    assert.equal(
      loaded?.workflowState,
      "BLOCKED",
    );
    assert.equal(
      loaded?.blockReason,
      "working tree is dirty",
    );
  },
);

test(
  "rejects corrupt JSON",
  () => {
    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "run-state-test-",
        ),
      );

    const store =
      new RunStateStore(dir);

    writeFileSync(
      join(
        dir,
        "broken-task.json",
      ),
      "{ invalid json",
      "utf8",
    );

    assert.throws(
      () =>
        store.load(
          "broken-task",
        ),
      /Invalid RunState JSON/,
    );
  },
);

test(
  "rejects invalid RunState",
  () => {
    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "run-state-test-",
        ),
      );

    const store =
      new RunStateStore(dir);

    writeFileSync(
      join(
        dir,
        "invalid-task.json",
      ),
      JSON.stringify({
        ...createInitialRunState(
          "invalid-task",
          "PREPARING",
          null,
        ),
        implementationCycle:
          -1,
      }),
      "utf8",
    );

    assert.throws(
      () =>
        store.load(
          "invalid-task",
        ),
      /implementationCycle/,
    );
  },
);

test(
  "migrates version 1 RunState through version 3",
  () => {
    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "run-state-test-",
        ),
      );

    const store =
      new RunStateStore(dir);

    writeFileSync(
      join(
        dir,
        "legacy-task.json",
      ),
      JSON.stringify({
        version: 1,
        taskId:
          "legacy-task",
        workflowState:
          "REVIEWING",
        implementationCycle:
          2,
        pullRequestNumber:
          44,
        reviewerFeedback:
          null,
        activeStage:
          null,
        activeConversationId:
          null,
        preparationConversationId:
          null,
        implementationConversationId:
          null,
        reviewConversationId:
          null,
        lastReviewerVerdict:
          null,
        createdAt:
          "2026-01-01T00:00:00.000Z",
        updatedAt:
          "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const loaded =
      store.load(
        "legacy-task",
      );

    assert.equal(
      loaded?.version,
      3,
    );
    assert.equal(
      loaded?.reviewAttempt,
      0,
    );
    assert.equal(
      loaded?.reviewHeadSha,
      null,
    );
    assert.equal(
      loaded?.approvedHeadSha,
      null,
    );
    assert.equal(
      loaded?.mergeCommitSha,
      null,
    );
    assert.equal(
      loaded?.preparationAttempt,
      0,
    );
    assert.equal(
      loaded?.blockReason,
      null,
    );
    assert.equal(
      loaded?.failureKind,
      null,
    );
  },
);

test(
  "migrates version 2 RunState by adding resilience fields",
  () => {
    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "run-state-test-",
        ),
      );

    const store =
      new RunStateStore(dir);

    const current =
      createInitialRunState(
        "legacy-v2",
        "IMPLEMENTING",
        7,
      );

    const {
      preparationAttempt:
        _preparationAttempt,
      blockReason:
        _blockReason,
      failureKind:
        _failureKind,
      failureMessage:
        _failureMessage,
      ...legacy
    } = current;

    writeFileSync(
      join(
        dir,
        "legacy-v2.json",
      ),
      JSON.stringify({
        ...legacy,
        version: 2,
      }),
      "utf8",
    );

    const loaded =
      store.load(
        "legacy-v2",
      );

    assert.equal(
      loaded?.version,
      3,
    );
    assert.equal(
      loaded?.preparationAttempt,
      0,
    );
    assert.equal(
      loaded?.blockReason,
      null,
    );
    assert.equal(
      loaded?.failureKind,
      null,
    );
  },
);

test(
  "rejects unknown RunState versions",
  () => {
    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "run-state-test-",
        ),
      );

    const store =
      new RunStateStore(dir);

    writeFileSync(
      join(
        dir,
        "future-task.json",
      ),
      JSON.stringify({
        ...createInitialRunState(
          "future-task",
          "PREPARING",
          null,
        ),
        version: 999,
      }),
      "utf8",
    );

    assert.throws(
      () =>
        store.load(
          "future-task",
        ),
      /version must be 3/,
    );
  },
);

test(
  "writes atomically through a temp file and final rename",
  () => {
    const store =
      temporaryStore();

    const state =
      createInitialRunState(
        "atomic-task",
        "IMPLEMENTING",
        9,
      );

    store.save(state);

    const raw =
      readFileSync(
        store.filePath(
          "atomic-task",
        ),
        "utf8",
      );

    assert.equal(
      JSON.parse(raw)
        .pullRequestNumber,
      9,
    );
  },
);
