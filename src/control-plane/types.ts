import type {
  FailureKind,
  WorkflowStage,
} from "../runState";
import type {
  ReviewerVerdict,
  WorkflowState,
} from "../workflow";

/**
 * Public, unambiguous Control Plane run statuses. These sit on top of the
 * internal WorkflowState machine (see src/workflow.ts) and fold in
 * request/response semantics (pause/cancel) plus resource-limit evidence
 * that WorkflowState alone does not distinguish.
 */
export type ControlPlaneStatus =
  | "RUNNING"
  | "PAUSE_REQUESTED"
  | "PAUSED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "BLOCKED"
  | "PAUSED_RESOURCE_LIMIT"
  | "FAILED"
  | "DONE"
  | "INTERRUPTED";

/** Statuses that represent a taskId with unfinished/pending work in flight. */
export const BLOCKING_STATUSES: ReadonlySet<ControlPlaneStatus> =
  new Set([
    "RUNNING",
    "PAUSE_REQUESTED",
    "PAUSED",
    "CANCEL_REQUESTED",
    "BLOCKED",
    "PAUSED_RESOURCE_LIMIT",
    "INTERRUPTED",
  ]);

/** Statuses from which POST /resume is accepted. */
export const RESUMABLE_STATUSES: ReadonlySet<ControlPlaneStatus> =
  new Set([
    "PAUSED",
    "PAUSED_RESOURCE_LIMIT",
    "INTERRUPTED",
    "BLOCKED",
  ]);

export const CONTROL_PLANE_STATE_VERSION = 1;

/**
 * Non-secret bookkeeping record for a single POST /api/runs attempt.
 * The authoritative workflow status lives in the RunState keyed by taskId
 * (see src/runState.ts); this record only maps a runId handle back to the
 * taskId/agentProfileId/workspace used to start or resume it.
 */
export interface ControlPlaneRunRecord {
  version: typeof CONTROL_PLANE_STATE_VERSION;
  runId: string;
  taskId: string;
  agentProfileId: string;
  /** Optional per-stage profile routing; legacy callers keep agentProfileId. */
  stageAgentProfileIds?: Partial<Record<WorkflowStage, string>>;
  workspace: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  runId: string;
  taskId: string;
  agentProfileId: string;
  status: ControlPlaneStatus;
  workflowState: WorkflowState | null;
  activeStage: WorkflowStage | null;
  blockReason: string | null;
  failureKind: FailureKind | null;
  pullRequestNumber: number | null;
  implementationCycle: number | null;
  lastReviewerVerdict: ReviewerVerdict | null;
  lastBlockerKey: string | null;
  repeatedBlockerCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  taskId: string;
  repository: {
    owner: string;
    name: string;
  };
  baseBranch: string;
  workingBranch: string;
  objective: string;
  maxReviewCycles: number | null;
  repeatedBlockerThreshold: number | null;
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {
  constructor(
    message: string,
    public readonly existingRunId?: string,
  ) {
    super(message);
  }
}
export class ServiceUnavailableError extends Error {}
