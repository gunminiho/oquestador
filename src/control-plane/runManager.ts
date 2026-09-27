import { randomUUID } from "node:crypto";

import { GhCliGitHubClient, type GitHubClient } from "../GitHubClient";
import {
  createInitialRunState,
  RunStateStore,
} from "../runState";
import { loadWorkflowTask } from "../taskLoader";
import { runTask } from "../taskRunner";
import type { WorkflowTask } from "../task";
import type { AgentClient } from "../workflowEngine";
import {
  DockerGitWorktreeManager,
  worktreePathForTask,
  type WorkspaceManager,
} from "../WorkspaceManager";

import { deriveControlPlaneStatus } from "./status";
import { ControlPlaneStore } from "./store";
import { resolveTaskFile } from "./taskResolver";
import {
  BLOCKING_STATUSES,
  CONTROL_PLANE_STATE_VERSION,
  ConflictError,
  NotFoundError,
  RESUMABLE_STATUSES,
  ServiceUnavailableError,
  ValidationError,
  type ControlPlaneRunRecord,
  type RunSummary,
} from "./types";

export interface RunManagerDependencies {
  taskRoot: string;
  runStateStore: RunStateStore;
  controlPlaneStore: ControlPlaneStore;
  client: AgentClient;
  defaultAgentProfileId?: string;
  github?: GitHubClient;
  workspaceManager?: WorkspaceManager;
  worktreeRoot?: string;
}

const DEFAULT_WORKTREE_ROOT =
  "/projects/.orchestrator-worktrees";

export interface StartRunInput {
  taskId: unknown;
  agentProfileId?: unknown;
}

/**
 * Owns the mapping from runId to a live (or restart-interrupted) workflow
 * run. It never runs the workflow inline on the HTTP request: startRun and
 * resumeRun kick off `runTask` and return immediately, tracking the promise
 * in-memory only to distinguish RUNNING from INTERRUPTED after a restart.
 */
export class RunManager {
  private readonly active = new Map<
    string,
    { taskId: string; promise: Promise<void> }
  >();
  private shuttingDown = false;
  private readonly github: GitHubClient;
  private readonly workspaceManager: WorkspaceManager;

  constructor(
    private readonly deps: RunManagerDependencies,
  ) {
    this.github =
      deps.github ??
      new GhCliGitHubClient();
    this.workspaceManager =
      deps.workspaceManager ??
      new DockerGitWorktreeManager();
  }

  shutdown(): void {
    this.shuttingDown = true;
  }

  async startRun(
    input: StartRunInput,
  ): Promise<RunSummary> {
    if (this.shuttingDown) {
      throw new ServiceUnavailableError(
        "Control Plane is shutting down; not accepting new runs.",
      );
    }

    const taskFilePath = resolveTaskFile(
      this.deps.taskRoot,
      input.taskId,
    );
    const task = loadWorkflowTask(
      taskFilePath,
    );

    const agentProfileId =
      this.resolveAgentProfileId(
        input.agentProfileId,
      );

    const blocking =
      this.findBlockingRunForTask(
        task.id,
      );

    if (blocking !== null) {
      throw new ConflictError(
        `Task ${task.id} already has an active run ${blocking.runId} (${blocking.status}). Use that run's pause/resume/cancel endpoints instead of starting a new one.`,
        blocking.runId,
      );
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const workspace = worktreePathForTask(
      this.deps.worktreeRoot ??
        DEFAULT_WORKTREE_ROOT,
      task,
    );

    const record: ControlPlaneRunRecord = {
      version:
        CONTROL_PLANE_STATE_VERSION,
      runId,
      taskId: task.id,
      agentProfileId,
      workspace,
      createdAt: now,
      updatedAt: now,
    };

    this.deps.controlPlaneStore.save(
      record,
    );

    // Seed a persisted RunState synchronously so a pause/cancel request
    // arriving immediately after this call always finds a workflow to
    // signal, instead of racing the async workspace preparation below.
    if (
      this.deps.runStateStore.load(
        task.id,
      ) === null
    ) {
      const initialWorkflowState =
        task.pullRequestNumber !==
        undefined
          ? "IMPLEMENTING"
          : "PREPARING";

      this.deps.runStateStore.save(
        createInitialRunState(
          task.id,
          initialWorkflowState,
          task.pullRequestNumber ?? null,
        ),
      );
    }

    this.launch(runId, task, agentProfileId);

    return this.requireRunSummary(runId);
  }

  async resumeRun(
    runId: string,
  ): Promise<RunSummary> {
    const summary =
      this.requireRunSummary(runId);

    if (
      summary.status === "DONE" ||
      summary.status === "CANCELLED"
    ) {
      throw new ConflictError(
        `Run ${runId} is ${summary.status} and cannot be resumed.`,
      );
    }

    if (
      !RESUMABLE_STATUSES.has(
        summary.status,
      )
    ) {
      throw new ConflictError(
        `Run ${runId} cannot be resumed from status ${summary.status}.`,
      );
    }

    if (this.shuttingDown) {
      throw new ServiceUnavailableError(
        "Control Plane is shutting down; not accepting resume requests.",
      );
    }

    const record =
      this.deps.controlPlaneStore.load(
        runId,
      );

    if (record === null) {
      throw new NotFoundError(
        `Run ${runId} not found.`,
      );
    }

    const task = loadWorkflowTask(
      resolveTaskFile(
        this.deps.taskRoot,
        record.taskId,
      ),
    );

    this.launch(
      runId,
      task,
      record.agentProfileId,
    );

    this.deps.controlPlaneStore.save(
      record,
    );

    return this.requireRunSummary(runId);
  }

  async pauseRun(
    runId: string,
  ): Promise<RunSummary> {
    const summary =
      this.requireRunSummary(runId);

    if (summary.status === "PAUSE_REQUESTED") {
      return summary;
    }

    if (summary.status !== "RUNNING") {
      throw new ConflictError(
        `Run ${runId} cannot be paused from status ${summary.status}.`,
      );
    }

    const runState =
      this.deps.runStateStore.load(
        summary.taskId,
      );

    if (runState === null) {
      throw new NotFoundError(
        `Run ${runId} has no workflow state to pause.`,
      );
    }

    this.deps.runStateStore.save({
      ...runState,
      controlSignal: "PAUSE_REQUESTED",
    });

    return this.requireRunSummary(runId);
  }

  async cancelRun(
    runId: string,
  ): Promise<RunSummary> {
    const summary =
      this.requireRunSummary(runId);

    if (
      summary.status === "DONE" ||
      summary.status === "CANCELLED"
    ) {
      throw new ConflictError(
        `Run ${runId} is already ${summary.status} and cannot be cancelled.`,
      );
    }

    if (summary.status === "CANCEL_REQUESTED") {
      return summary;
    }

    const runState =
      this.deps.runStateStore.load(
        summary.taskId,
      );

    if (runState === null) {
      throw new NotFoundError(
        `Run ${runId} has no workflow state to cancel.`,
      );
    }

    if (this.active.has(runId)) {
      this.deps.runStateStore.save({
        ...runState,
        controlSignal: "CANCEL_REQUESTED",
      });
    } else {
      // Nothing is actively driving this run right now (it is BLOCKED,
      // PAUSED, or INTERRUPTED after a restart): there is no in-flight
      // stage to let finish, so this checkpoint is already safe.
      this.deps.runStateStore.save({
        ...runState,
        workflowState: "CANCELLED",
        cancelledFromState:
          runState.workflowState,
        controlSignal: "NONE",
      });
    }

    return this.requireRunSummary(runId);
  }

  getRun(runId: string): RunSummary {
    return this.requireRunSummary(runId);
  }

  listRuns(): RunSummary[] {
    return this.deps.controlPlaneStore
      .list()
      .map((record) =>
        this.summarize(record),
      )
      .filter(
        (
          summary,
        ): summary is RunSummary =>
          summary !== null,
      )
      .sort((a, b) =>
        a.createdAt.localeCompare(
          b.createdAt,
        ),
      );
  }

  private resolveAgentProfileId(
    requested: unknown,
  ): string {
    if (requested === undefined) {
      if (
        !this.deps
          .defaultAgentProfileId
      ) {
        throw new ValidationError(
          "agentProfileId is required: no default agentProfileId is configured.",
        );
      }

      return this.deps
        .defaultAgentProfileId;
    }

    if (
      typeof requested !== "string" ||
      requested.trim() === ""
    ) {
      throw new ValidationError(
        "agentProfileId must be a non-empty string when provided.",
      );
    }

    return requested;
  }

  private findBlockingRunForTask(
    taskId: string,
  ): RunSummary | null {
    for (const record of this.deps.controlPlaneStore.list()) {
      if (record.taskId !== taskId) {
        continue;
      }

      const summary = this.summarize(
        record,
      );

      if (
        summary !== null &&
        BLOCKING_STATUSES.has(
          summary.status,
        )
      ) {
        return summary;
      }
    }

    return null;
  }

  private launch(
    runId: string,
    task: WorkflowTask,
    agentProfileId: string,
  ): void {
    const promise = runTask(
      {
        task,
        agentProfileId,
      },
      {
        client: this.deps.client,
        store: this.deps.runStateStore,
        github: this.github,
        workspaceManager:
          this.workspaceManager,
      },
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(
          `Run ${runId} (task ${task.id}) ended with an unhandled error:`,
          error instanceof Error
            ? error.message
            : error,
        );
      })
      .finally(() => {
        this.active.delete(runId);
      });

    this.active.set(runId, {
      taskId: task.id,
      promise,
    });
  }

  private requireRunSummary(
    runId: string,
  ): RunSummary {
    const record =
      this.deps.controlPlaneStore.load(
        runId,
      );

    if (record === null) {
      throw new NotFoundError(
        `Run ${runId} not found.`,
      );
    }

    const summary = this.summarize(
      record,
    );

    if (summary === null) {
      throw new NotFoundError(
        `Run ${runId} not found.`,
      );
    }

    return summary;
  }

  private summarize(
    record: ControlPlaneRunRecord,
  ): RunSummary | null {
    const runState =
      this.deps.runStateStore.load(
        record.taskId,
      );

    const isActive = this.active.has(
      record.runId,
    );

    const status =
      runState === null
        ? "INTERRUPTED"
        : deriveControlPlaneStatus(
            runState,
            isActive,
          );

    return {
      runId: record.runId,
      taskId: record.taskId,
      agentProfileId:
        record.agentProfileId,
      status,
      workflowState:
        runState?.workflowState ??
        null,
      activeStage:
        runState?.activeStage ?? null,
      blockReason:
        runState?.blockReason ?? null,
      failureKind:
        runState?.failureKind ?? null,
      pullRequestNumber:
        runState?.pullRequestNumber ??
        null,
      implementationCycle:
        runState?.implementationCycle ??
        null,
      lastReviewerVerdict:
        runState?.lastReviewerVerdict ??
        null,
      lastBlockerKey:
        runState?.lastBlockerKey ??
        null,
      repeatedBlockerCount:
        runState?.repeatedBlockerCount ??
        null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
