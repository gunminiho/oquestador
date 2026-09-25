import test from "node:test";
import assert from "node:assert/strict";

import {
  worktreePathForTask,
} from "./WorkspaceManager";

test(
  "worktree path is deterministic",
  () => {
    assert.equal(
      worktreePathForTask(
        "/projects/.orchestrator-worktrees/",
        "task-1",
      ),
      "/projects/.orchestrator-worktrees/task-1",
    );
  },
);

test(
  "worktree path rejects traversal",
  () => {
    assert.throws(
      () =>
        worktreePathForTask(
          "/projects/.orchestrator-worktrees",
          "../escape",
        ),
      /unsafe/,
    );
  },
);
