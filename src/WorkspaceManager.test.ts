import test from "node:test";
import assert from "node:assert/strict";

import type {
  WorkflowTask,
} from "./task";
import {
  DockerGitWorktreeManager,
  worktreePathForTask,
} from "./WorkspaceManager";

function task(): WorkflowTask {
  return {
    id: "task-1",
    repository: {
      owner: "gunminiho",
      name: "oquestador",
    },
    workspace:
      "/projects/oquestador",
    baseBranch: "main",
    workingBranch:
      "feat/task-1",
    objective: "test",
    acceptanceCriteria: [
      "works",
    ],
  };
}

const WORKTREE_ROOT =
  "/projects/.orchestrator-worktrees";

function expectedWorktree(
  value = task(),
): string {
  return worktreePathForTask(
    WORKTREE_ROOT,
    value,
  );
}

class FakeDocker {
  readonly calls:
    string[][] = [];

  existingWorktree =
    false;
  baseExists =
    true;
  remoteWorkingExists =
    false;
  dirty =
    false;
  head =
    "1111111111111111111111111111111111111111";
  remoteHead =
    "1111111111111111111111111111111111111111";

  run = async (
    args: string[],
  ): Promise<string> => {
    this.calls.push([
      ...args,
    ]);

    const joined =
      args.join(" ");

    if (
      joined.includes(
        "/projects/.orchestrator-worktrees/task-1 rev-parse HEAD",
      )
    ) {
      if (
        !this.existingWorktree &&
        this.calls.length ===
          1
      ) {
        throw new Error(
          "missing worktree",
        );
      }

      return `${this.head}\n`;
    }

    if (
      joined.includes(
        "show-ref --verify --quiet refs/remotes/origin/main",
      )
    ) {
      if (
        !this.baseExists
      ) {
        throw new Error(
          "missing base",
        );
      }

      return "";
    }

    if (
      joined.includes(
        "show-ref --verify --quiet refs/remotes/origin/feat/task-1",
      )
    ) {
      if (
        !this.remoteWorkingExists
      ) {
        throw new Error(
          "missing working ref",
        );
      }

      return "";
    }

    if (
      joined.includes(
        "status --porcelain",
      )
    ) {
      return this.dirty
        ? " M file.ts\n"
        : "";
    }

    if (
      joined.includes(
        "origin/feat/task-1",
      ) &&
      joined.includes(
        "rev-parse",
      )
    ) {
      return `${this.remoteHead}\n`;
    }

    return "";
  };
}

test(
  "worktree path is deterministic",
  () => {
    assert.equal(
      worktreePathForTask(
        "/projects/.orchestrator-worktrees/",
        "task-1",
      ),
      expectedWorktree(),
    );
  },
);

test(
  "worktree path changes when repository or branch identity changes",
  () => {
    const base =
      worktreePathForTask(
        WORKTREE_ROOT,
        task(),
      );

    const otherBranch =
      worktreePathForTask(
        WORKTREE_ROOT,
        {
          ...task(),
          workingBranch:
            "feat/other",
        },
      );

    const otherRepo =
      worktreePathForTask(
        WORKTREE_ROOT,
        {
          ...task(),
          repository: {
            owner:
              "gunminiho",
            name:
              "another-repo",
          },
        },
      );

    assert.notEqual(
      base,
      otherBranch,
    );

    assert.notEqual(
      base,
      otherRepo,
    );

    assert.match(
      base,
      /\/task-1-[0-9a-f]{12}$/,
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
          {
            ...task(),
            id: "../escape",
          },
        ),
      /unsafe/,
    );
  },
);

test(
  "new task creates a detached worktree from base without altering source checkout",
  async () => {
    const fake =
      new FakeDocker();

    const manager =
      new DockerGitWorktreeManager(
        "canvas",
        "/projects/.orchestrator-worktrees",
        fake.run,
      );

    const prepared =
      await manager.prepare(
        task(),
      );

    assert.equal(
      prepared.workspace,
      expectedWorktree(),
    );

    const worktreeAdd =
      fake.calls.find(
        (args) =>
          args.includes(
            "worktree",
          ) &&
          args.includes(
            "add",
          ),
      );

    assert.ok(
      worktreeAdd,
    );
    assert.ok(
      worktreeAdd.includes(
        "--detach",
      ),
    );
    assert.equal(
      worktreeAdd.at(-1),
      "origin/main",
    );

    const all =
      fake.calls
        .flat()
        .join(" ");

    assert.doesNotMatch(
      all,
      /\breset\b|\bstash\b|\bswitch\b/,
    );
  },
);

test(
  "existing remote working branch is the detached worktree start ref",
  async () => {
    const fake =
      new FakeDocker();

    fake.remoteWorkingExists =
      true;

    const manager =
      new DockerGitWorktreeManager(
        "canvas",
        "/projects/.orchestrator-worktrees",
        fake.run,
      );

    await manager.prepare(
      task(),
    );

    const worktreeAdd =
      fake.calls.find(
        (args) =>
          args.includes(
            "worktree",
          ) &&
          args.includes(
            "add",
          ),
      );

    assert.equal(
      worktreeAdd?.at(-1),
      "origin/feat/task-1",
    );
  },
);

test(
  "existing task worktree is reused without fetching or recreating it",
  async () => {
    const fake =
      new FakeDocker();

    fake.existingWorktree =
      true;

    const manager =
      new DockerGitWorktreeManager(
        "canvas",
        "/projects/.orchestrator-worktrees",
        fake.run,
      );

    const prepared =
      await manager.prepare(
        task(),
      );

    assert.equal(
      prepared.workspace,
      expectedWorktree(),
    );

    assert.equal(
      fake.calls.length,
      1,
    );
  },
);

test(
  "cleanup preserves dirty worktree",
  async () => {
    const fake =
      new FakeDocker();

    fake.existingWorktree =
      true;
    fake.dirty =
      true;

    const manager =
      new DockerGitWorktreeManager(
        "canvas",
        "/projects/.orchestrator-worktrees",
        fake.run,
      );

    const cleaned =
      await manager.cleanup({
        workspace:
          expectedWorktree(),
        sourceWorkspace:
          "/projects/oquestador",
        workingBranch:
          "feat/task-1",
      });

    assert.equal(
      cleaned,
      false,
    );

    assert.equal(
      fake.calls.some(
        (args) =>
          args.includes(
            "remove",
          ),
      ),
      false,
    );
  },
);

test(
  "cleanup removes only a clean worktree whose HEAD is fully published",
  async () => {
    const fake =
      new FakeDocker();

    fake.existingWorktree =
      true;
    fake.remoteWorkingExists =
      true;

    const manager =
      new DockerGitWorktreeManager(
        "canvas",
        "/projects/.orchestrator-worktrees",
        fake.run,
      );

    const cleaned =
      await manager.cleanup({
        workspace:
          expectedWorktree(),
        sourceWorkspace:
          "/projects/oquestador",
        workingBranch:
          "feat/task-1",
      });

    assert.equal(
      cleaned,
      true,
    );

    assert.equal(
      fake.calls.some(
        (args) =>
          args.includes(
            "worktree",
          ) &&
          args.includes(
            "remove",
          ),
      ),
      true,
    );
  },
);
