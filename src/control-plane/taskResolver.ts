import {
  type Dirent,
  existsSync,
  readdirSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import { loadWorkflowTask } from "../taskLoader";
import { NotFoundError, ValidationError } from "./types";
import type { TaskSummary } from "./types";

const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Resolves a client-supplied `taskId` to a task JSON file strictly inside
 * `taskRoot`. Rejects path traversal, absolute paths, and any character
 * outside the same safe alphabet already used for WorkflowTask.id and
 * RunState file names, so a POST /api/runs body can never reach an
 * arbitrary path or execute an arbitrary command.
 */
export function resolveTaskFile(
  taskRoot: string,
  taskId: unknown,
): string {
  if (
    typeof taskId !== "string" ||
    taskId.trim() === ""
  ) {
    throw new ValidationError(
      "taskId is required and must be a non-empty string.",
    );
  }

  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new ValidationError(
      "taskId may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }

  const root = resolve(taskRoot);
  const candidate = resolve(
    root,
    `${taskId}.json`,
  );

  if (
    candidate !== root &&
    !candidate.startsWith(root + sep)
  ) {
    throw new ValidationError(
      "Resolved task path escapes the configured task root.",
    );
  }

  if (!existsSync(candidate)) {
    throw new NotFoundError(
      `Unknown taskId: ${taskId}`,
    );
  }

  return candidate;
}

export function summarizeTaskFile(
  taskRoot: string,
  taskId: unknown,
): TaskSummary {
  const task = loadWorkflowTask(
    resolveTaskFile(taskRoot, taskId),
  );

  return {
    taskId: task.id,
    repository: {
      owner: task.repository.owner,
      name: task.repository.name,
    },
    baseBranch: task.baseBranch,
    workingBranch:
      task.workingBranch,
    objective: task.objective,
    maxReviewCycles:
      task.maxReviewCycles ?? null,
    repeatedBlockerThreshold:
      task.repeatedBlockerThreshold ??
      null,
  };
}

export function listTaskSummaries(
  taskRoot: string,
): TaskSummary[] {
  const root = resolve(taskRoot);
  let entries: Dirent[];

  try {
    entries = readdirSync(root, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json"),
    )
    .flatMap((entry) => {
      const taskId = entry.name.slice(
        0,
        -".json".length,
      );

      if (!TASK_ID_PATTERN.test(taskId)) {
        return [];
      }

      try {
        return [
          summarizeTaskFile(root, taskId),
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    );
}
