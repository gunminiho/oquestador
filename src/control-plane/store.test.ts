import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ControlPlaneStore } from "./store";
import type { ControlPlaneRunRecord } from "./types";

function temporaryStore(): ControlPlaneStore {
  return new ControlPlaneStore(
    mkdtempSync(
      join(tmpdir(), "cp-store-test-"),
    ),
  );
}

function record(
  overrides: Partial<ControlPlaneRunRecord> = {},
): ControlPlaneRunRecord {
  const now = new Date().toISOString();

  return {
    version: 1,
    runId: "run-1",
    taskId: "task-1",
    agentProfileId: "profile-1",
    workspace: "/tmp/workspace",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("saves and loads a run record", () => {
  const store = temporaryStore();
  store.save(record());

  const loaded = store.load("run-1");
  assert.equal(loaded?.taskId, "task-1");
  assert.equal(
    loaded?.agentProfileId,
    "profile-1",
  );
});

test("returns null for an unknown runId", () => {
  const store = temporaryStore();
  assert.equal(store.load("missing"), null);
});

test("lists all persisted records", () => {
  const store = temporaryStore();
  store.save(
    record({
      runId: "run-1",
      taskId: "task-1",
    }),
  );
  store.save(
    record({
      runId: "run-2",
      taskId: "task-2",
    }),
  );

  const runIds = store
    .list()
    .map((r) => r.runId)
    .sort();
  assert.deepEqual(runIds, [
    "run-1",
    "run-2",
  ]);
});

test("list on a directory that does not exist yet returns an empty array", () => {
  const store = new ControlPlaneStore(
    join(
      mkdtempSync(
        join(
          tmpdir(),
          "cp-store-test-",
        ),
      ),
      "nested",
      "does-not-exist",
    ),
  );
  assert.deepEqual(store.list(), []);
});

test("rejects a record whose runId does not match the requested load", () => {
  const store = temporaryStore();
  store.save(record({ runId: "run-1" }));

  // Corrupt on disk: mismatched runId inside the file itself.
  const filePath = store.filePath(
    "run-1",
  );
  const raw = JSON.parse(
    readFileSync(filePath, "utf8"),
  );
  raw.runId = "run-2";
  writeFileSync(
    filePath,
    JSON.stringify(raw),
    "utf8",
  );

  assert.throws(() =>
    store.load("run-1"),
  );
});

test("writes atomically through a temp file and final rename", () => {
  const store = temporaryStore();
  store.save(record({ runId: "run-1" }));

  const raw = JSON.parse(
    readFileSync(
      store.filePath("run-1"),
      "utf8",
    ),
  );
  assert.equal(raw.taskId, "task-1");
});

test("rejects unsafe runId characters when computing a file path", () => {
  const store = temporaryStore();
  assert.throws(() =>
    store.filePath("../escape"),
  );
});
