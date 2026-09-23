import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type WorkflowTask,
  validateWorkflowTask,
} from "./task";

export function loadWorkflowTask(
  filePath: string,
): WorkflowTask {
  const absolutePath = resolve(filePath);

  const raw = readFileSync(
    absolutePath,
    "utf8",
  );

  const normalized = raw.replace(/^\uFEFF/, "");

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized);
  } catch (error: unknown) {
    throw new Error(
      `Invalid task JSON: ${absolutePath}`,
      { cause: error },
    );
  }

  const task = parsed as WorkflowTask;

  validateWorkflowTask(task);

  return task;
}
