import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveTaskFile } from "./taskResolver";
import { NotFoundError, ValidationError } from "./types";

function taskRoot(): string {
  const dir = mkdtempSync(
    join(tmpdir(), "task-resolver-"),
  );
  writeFileSync(
    join(dir, "known-task.json"),
    "{}",
    "utf8",
  );
  return dir;
}

test("resolves a known taskId to a file inside the task root", () => {
  const root = taskRoot();
  const filePath = resolveTaskFile(
    root,
    "known-task",
  );
  assert.equal(
    filePath,
    join(root, "known-task.json"),
  );
});

test("rejects an unknown taskId with NotFoundError", () => {
  const root = taskRoot();
  assert.throws(
    () =>
      resolveTaskFile(
        root,
        "missing-task",
      ),
    NotFoundError,
  );
});

test("rejects path traversal attempts", () => {
  const root = taskRoot();

  for (const attempt of [
    "../outside",
    "..%2Foutside",
    "a/../../outside",
    "/etc/passwd",
  ]) {
    assert.throws(
      () =>
        resolveTaskFile(root, attempt),
      ValidationError,
      `expected ${attempt} to be rejected`,
    );
  }
});

test("rejects taskIds with unsafe characters", () => {
  const root = taskRoot();

  for (const attempt of [
    "with spaces",
    "semi;colon",
    "pipe|char",
    "$(command)",
    "`backtick`",
    "",
  ]) {
    assert.throws(
      () =>
        resolveTaskFile(root, attempt),
      ValidationError,
      `expected ${JSON.stringify(attempt)} to be rejected`,
    );
  }
});

test("rejects non-string taskId values", () => {
  const root = taskRoot();

  for (const attempt of [
    123,
    null,
    undefined,
    {},
    [],
  ]) {
    assert.throws(
      () =>
        resolveTaskFile(root, attempt),
      ValidationError,
    );
  }
});
