import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import { NotFoundError, ValidationError } from "./types";

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
