import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WorkflowTask } from "./task";

const execFileAsync =
  promisify(execFile);

export interface PreparedWorkspace {
  workspace: string;
  sourceWorkspace: string;
  workingBranch: string;
}

export interface WorkspaceManager {
  prepare(
    task: WorkflowTask,
  ): Promise<PreparedWorkspace>;

  cleanup(
    prepared: PreparedWorkspace,
  ): Promise<boolean>;
}

export function worktreePathForTask(
  root: string,
  taskId: string,
): string {
  if (
    !/^[A-Za-z0-9._-]+$/.test(
      taskId,
    )
  ) {
    throw new Error(
      "Task id is unsafe for a worktree path.",
    );
  }

  return (
    `${root.replace(/\/+$/, "")}/${taskId}`
  );
}

export class DockerGitWorktreeManager
implements WorkspaceManager {
  constructor(
    private readonly containerName =
      process.env.OH_AGENT_CONTAINER ??
      "openhands-canvas",
    private readonly worktreeRoot =
      process.env.OH_WORKTREE_ROOT ??
      "/projects/.orchestrator-worktrees",
  ) {}

  async prepare(
    task: WorkflowTask,
  ): Promise<PreparedWorkspace> {
    const target =
      worktreePathForTask(
        this.worktreeRoot,
        task.id,
      );

    const existingBranch =
      await this.tryGit(
        target,
        [
          "branch",
          "--show-current",
        ],
      );

    if (
      existingBranch !== null
    ) {
      if (
        existingBranch.trim() !==
        task.workingBranch
      ) {
        throw new Error(
          `Existing worktree ${target} is on ${existingBranch.trim()}, expected ${task.workingBranch}.`,
        );
      }

      return {
        workspace: target,
        sourceWorkspace:
          task.workspace,
        workingBranch:
          task.workingBranch,
      };
    }

    await this.git(
      task.workspace,
      [
        "fetch",
        "origin",
      ],
    );

    await this.docker([
      "mkdir",
      "-p",
      this.worktreeRoot,
    ]);

    if (
      !(
        await this.refExists(
          task.workspace,
          `refs/remotes/origin/${task.baseBranch}`,
        )
      )
    ) {
      throw new Error(
        `origin/${task.baseBranch} does not exist.`,
      );
    }

    const localBranchExists =
      await this.refExists(
        task.workspace,
        `refs/heads/${task.workingBranch}`,
      );

    const remoteBranchExists =
      await this.refExists(
        task.workspace,
        `refs/remotes/origin/${task.workingBranch}`,
      );

    if (localBranchExists) {
      await this.git(
        task.workspace,
        [
          "worktree",
          "add",
          target,
          task.workingBranch,
        ],
      );
    } else if (
      remoteBranchExists
    ) {
      await this.git(
        task.workspace,
        [
          "worktree",
          "add",
          "--track",
          "-b",
          task.workingBranch,
          target,
          `origin/${task.workingBranch}`,
        ],
      );
    } else {
      await this.git(
        task.workspace,
        [
          "worktree",
          "add",
          "-b",
          task.workingBranch,
          target,
          `origin/${task.baseBranch}`,
        ],
      );
    }

    await this.docker([
      "git",
      "config",
      "--global",
      "--add",
      "safe.directory",
      target,
    ]);

    return {
      workspace: target,
      sourceWorkspace:
        task.workspace,
      workingBranch:
        task.workingBranch,
    };
  }

  async cleanup(
    prepared: PreparedWorkspace,
  ): Promise<boolean> {
    const status =
      await this.git(
        prepared.workspace,
        [
          "status",
          "--porcelain",
        ],
      );

    if (
      status.trim() !== ""
    ) {
      return false;
    }

    await this.git(
      prepared.sourceWorkspace,
      [
        "fetch",
        "origin",
      ],
    );

    if (
      !(
        await this.refExists(
          prepared.sourceWorkspace,
          `refs/remotes/origin/${prepared.workingBranch}`,
        )
      )
    ) {
      return false;
    }

    const head =
      (
        await this.git(
          prepared.workspace,
          [
            "rev-parse",
            "HEAD",
          ],
        )
      ).trim();

    const remoteHead =
      (
        await this.git(
          prepared.sourceWorkspace,
          [
            "rev-parse",
            `origin/${prepared.workingBranch}`,
          ],
        )
      ).trim();

    if (
      head !== remoteHead
    ) {
      return false;
    }

    await this.git(
      prepared.sourceWorkspace,
      [
        "worktree",
        "remove",
        prepared.workspace,
      ],
    );

    return true;
  }

  private async refExists(
    repo: string,
    ref: string,
  ): Promise<boolean> {
    try {
      await this.docker([
        "git",
        "-C",
        repo,
        "show-ref",
        "--verify",
        "--quiet",
        ref,
      ]);

      return true;
    } catch {
      return false;
    }
  }

  private async tryGit(
    repo: string,
    args: string[],
  ): Promise<string | null> {
    try {
      return await this.git(
        repo,
        args,
      );
    } catch {
      return null;
    }
  }

  private async git(
    repo: string,
    args: string[],
  ): Promise<string> {
    return this.docker([
      "git",
      "-C",
      repo,
      ...args,
    ]);
  }

  private async docker(
    args: string[],
  ): Promise<string> {
    const { stdout } =
      await execFileAsync(
        "docker",
        [
          "exec",
          this.containerName,
          ...args,
        ],
      );

    return stdout;
  }
}
