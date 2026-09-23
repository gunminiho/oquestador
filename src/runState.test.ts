import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    mkdtempSync(join(tmpdir(), "run-state-test-")),
  );
}

test("creates, saves, and loads initial RunState", () => {
  const store = temporaryStore();
  const state = createInitialRunState(
    "task-1",
    "PREPARING",
    null,
    new Date("2026-01-01T00:00:00.000Z"),
  );

  store.save(state);

  const loaded = store.load("task-1");

  assert.equal(loaded?.taskId, "task-1");
  assert.equal(loaded?.workflowState, "PREPARING");
  assert.equal(loaded?.implementationCycle, 0);
  assert.equal(loaded?.pullRequestNumber, null);
  assert.equal(loaded?.reviewerFeedback, null);
  assert.equal(loaded?.activeConversationId, null);
});

test("preserves implementationCycle, pullRequestNumber, and reviewerFeedback", () => {
  const store = temporaryStore();
  const state = {
    ...createInitialRunState("task-2", "REVIEWING", 47),
    implementationCycle: 3,
    reviewerFeedback: "full reviewer feedback",
    activeStage: "REVIEW" as const,
    activeConversationId: "review-1",
    reviewConversationId: "review-1",
    lastReviewerVerdict: "CHANGES_REQUESTED" as const,
  };

  store.save(state);

  const loaded = store.load("task-2");

  assert.equal(loaded?.implementationCycle, 3);
  assert.equal(loaded?.pullRequestNumber, 47);
  assert.equal(loaded?.reviewerFeedback, "full reviewer feedback");
});

test("rejects corrupt JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-state-test-"));
  const store = new RunStateStore(dir);

  writeFileSync(
    join(dir, "broken-task.json"),
    "{ invalid json",
    "utf8",
  );

  assert.throws(
    () => store.load("broken-task"),
    /Invalid RunState JSON/,
  );
});

test("rejects invalid RunState", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-state-test-"));
  const store = new RunStateStore(dir);

  writeFileSync(
    join(dir, "invalid-task.json"),
    JSON.stringify({
      ...createInitialRunState(
        "invalid-task",
        "PREPARING",
        null,
      ),
      implementationCycle: -1,
    }),
    "utf8",
  );

  assert.throws(
    () => store.load("invalid-task"),
    /implementationCycle/,
  );
});

test("writes atomically through a temp file and final rename", () => {
  const store = temporaryStore();
  const state = createInitialRunState(
    "atomic-task",
    "IMPLEMENTING",
    9,
  );

  store.save(state);

  const raw = readFileSync(
    store.filePath("atomic-task"),
    "utf8",
  );

  assert.equal(JSON.parse(raw).pullRequestNumber, 9);
});
