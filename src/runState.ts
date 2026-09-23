import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  type ReviewerVerdict,
  type WorkflowState,
} from "./workflow";

export const RUN_STATE_VERSION = 1;

export type WorkflowStage =
  | "PREPARATION"
  | "IMPLEMENTATION"
  | "REVIEW";

export interface RunState {
  version: typeof RUN_STATE_VERSION;
  taskId: string;
  workflowState: WorkflowState;
  implementationCycle: number;
  pullRequestNumber: number | null;
  reviewerFeedback: string | null;
  activeStage: WorkflowStage | null;
  activeConversationId: string | null;
  preparationConversationId: string | null;
  implementationConversationId: string | null;
  reviewConversationId: string | null;
  lastReviewerVerdict: ReviewerVerdict | null;
  createdAt: string;
  updatedAt: string;
}

export function createInitialRunState(
  taskId: string,
  workflowState: WorkflowState,
  pullRequestNumber: number | null,
  now = new Date(),
): RunState {
  const timestamp = now.toISOString();

  return {
    version: RUN_STATE_VERSION,
    taskId,
    workflowState,
    implementationCycle: 0,
    pullRequestNumber,
    reviewerFeedback: null,
    activeStage: null,
    activeConversationId: null,
    preparationConversationId: null,
    implementationConversationId: null,
    reviewConversationId: null,
    lastReviewerVerdict: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class RunStateStore {
  constructor(
    private readonly baseDir = ".orchestrator/runs",
  ) {}

  load(taskId: string): RunState | null {
    const filePath = this.filePath(taskId);

    if (!existsSync(filePath)) {
      return null;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error: unknown) {
      throw new Error(
        `Invalid RunState JSON for task ${taskId}: ${filePath}`,
        { cause: error },
      );
    }

    return validateRunState(parsed, taskId, filePath);
  }

  save(state: RunState): void {
    validateRunState(state, state.taskId);

    const filePath = this.filePath(state.taskId);
    mkdirSync(dirname(filePath), { recursive: true });

    const nextState: RunState = {
      ...state,
      updatedAt: new Date().toISOString(),
    };

    const temporaryPath =
      `${filePath}.${process.pid}.${Date.now()}.tmp`;

    writeFileSync(
      temporaryPath,
      `${JSON.stringify(nextState, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, filePath);
  }

  filePath(taskId: string): string {
    return join(this.baseDir, `${safeTaskId(taskId)}.json`);
  }
}

export function validateRunState(
  value: unknown,
  expectedTaskId?: string,
  source = "RunState",
): RunState {
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object.`);
  }

  assertEqual(value.version, RUN_STATE_VERSION, `${source}.version`);
  assertString(value.taskId, `${source}.taskId`);

  if (expectedTaskId !== undefined && value.taskId !== expectedTaskId) {
    throw new Error(
      `${source}.taskId must be ${expectedTaskId}, got ${value.taskId}.`,
    );
  }

  assertWorkflowState(value.workflowState, `${source}.workflowState`);
  assertNonNegativeInteger(
    value.implementationCycle,
    `${source}.implementationCycle`,
  );
  assertNullablePositiveInteger(
    value.pullRequestNumber,
    `${source}.pullRequestNumber`,
  );
  assertNullableString(
    value.reviewerFeedback,
    `${source}.reviewerFeedback`,
  );
  assertNullableStage(value.activeStage, `${source}.activeStage`);
  assertNullableString(
    value.activeConversationId,
    `${source}.activeConversationId`,
  );
  assertNullableString(
    value.preparationConversationId,
    `${source}.preparationConversationId`,
  );
  assertNullableString(
    value.implementationConversationId,
    `${source}.implementationConversationId`,
  );
  assertNullableString(
    value.reviewConversationId,
    `${source}.reviewConversationId`,
  );
  assertNullableVerdict(
    value.lastReviewerVerdict,
    `${source}.lastReviewerVerdict`,
  );
  assertString(value.createdAt, `${source}.createdAt`);
  assertString(value.updatedAt, `${source}.updatedAt`);

  return value as unknown as RunState;
}

function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(
      "RunState taskId may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }

  return taskId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEqual(
  value: unknown,
  expected: unknown,
  field: string,
): void {
  if (value !== expected) {
    throw new Error(`${field} must be ${String(expected)}.`);
  }
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertNullableString(value: unknown, field: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${field} must be a string or null.`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
}

function assertNullablePositiveInteger(
  value: unknown,
  field: string,
): void {
  if (
    value !== null &&
    (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0
    )
  ) {
    throw new Error(`${field} must be a positive integer or null.`);
  }
}

function assertWorkflowState(value: unknown, field: string): void {
  if (
    value !== "PREPARING" &&
    value !== "IMPLEMENTING" &&
    value !== "REVIEWING" &&
    value !== "DONE" &&
    value !== "FAILED"
  ) {
    throw new Error(`${field} is invalid.`);
  }
}

function assertNullableStage(value: unknown, field: string): void {
  if (
    value !== null &&
    value !== "PREPARATION" &&
    value !== "IMPLEMENTATION" &&
    value !== "REVIEW"
  ) {
    throw new Error(`${field} is invalid.`);
  }
}

function assertNullableVerdict(value: unknown, field: string): void {
  if (
    value !== null &&
    value !== "APPROVED" &&
    value !== "CHANGES_REQUESTED"
  ) {
    throw new Error(`${field} is invalid.`);
  }
}
