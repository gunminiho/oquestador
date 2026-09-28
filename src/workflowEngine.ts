import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ConversationTerminalError,
  OpenHandsTransientError,
} from "./OpenHandsClient";
import {
  GhCliGitHubClient,
  type GitHubClient,
  type PullRequestDetails,
} from "./GitHubClient";
import {
  buildImplementationMessage,
  buildNoChangesReviewMessage,
  buildPreparationMessage,
  buildReviewMessage,
  repositoryName,
} from "./orchestratorMessages";
import {
  createInitialRunState,
  type FailureKind,
  type RunState,
  RunStateStore,
  type WorkflowStage,
} from "./runState";
import {
  DEFAULT_REPEATED_BLOCKER_THRESHOLD,
  type WorkflowTask,
} from "./task";
import {
  nextStateAfterReview,
  parseImplementationResult,
  parsePreparationResult,
  parseReviewOutcome,
  type ReviewOutcome,
  type WorkflowState,
} from "./workflow";
import type { RequestedExecution, ResolvedExecution } from "./executionRouting";

const execFileAsync =
  promisify(execFile);

export interface TerminalErrorDetail {
  code: string | null;
  detail: string | null;
}

const RESOURCE_LIMIT_ERROR_CODES =
  new Set([
    "rate_limit",
    "usage_limit_exceeded",
    "quota_exceeded",
    "billing_error",
  ]);

async function safeGetTerminalErrorDetail(
  client: AgentClient,
  conversationId: string,
): Promise<TerminalErrorDetail | null> {
  if (
    client.getTerminalErrorDetail ===
    undefined
  ) {
    return null;
  }

  try {
    return await client.getTerminalErrorDetail(
      conversationId,
    );
  } catch {
    return null;
  }
}

export function isResourceLimitEvidence(
  detail: TerminalErrorDetail | null,
): boolean {
  if (detail === null) {
    return false;
  }

  if (
    detail.code !== null &&
    RESOURCE_LIMIT_ERROR_CODES.has(
      detail.code,
    )
  ) {
    return true;
  }

  const text =
    detail.detail ?? "";

  return (
    /usage limit|quota exceeded|rate limit exceeded/i.test(
      text,
    )
  );
}

export interface AgentClient {
  createConversation(options: {
    workspace: string;
    agentProfileId: string;
    message: string;
    conversationId?: string;
  }): Promise<{
    id: string;
    execution_status?: string;
  }>;

  getConversation(
    conversationId: string,
  ): Promise<{
    id: string;
    execution_status: string;
  }>;

  waitUntilFinished(
    conversationId: string,
    options?: {
      pollIntervalMs?: number;
    },
  ): Promise<{
    id: string;
    execution_status: string;
  }>;

  getFinalResponse(
    conversationId: string,
  ): Promise<string>;

  getTerminalErrorDetail?(
    conversationId: string,
  ): Promise<TerminalErrorDetail | null>;
}

export interface RunWorkflowOptions {
  client: AgentClient;
  task: WorkflowTask;
  store: RunStateStore;
  agentProfileId: string;
  stageAgentProfileIds?: Partial<Record<WorkflowStage, string>>;
  stageExecutions?: Partial<Record<WorkflowStage, { requested: RequestedExecution; resolved: ResolvedExecution }>>;
  initialStateOverride?: WorkflowState;
  pollIntervalMs?: number;
  github?: GitHubClient;
}

function requiredEnv(
  name: string,
): string {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`,
    );
  }

  return value;
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<RunState> {
  const task =
    options.task;

  const github =
    options.github ??
    new GhCliGitHubClient();

  let runState =
    loadOrCreateRunState(
      options,
    );

  task.pullRequestNumber =
    runState.pullRequestNumber ??
    undefined;

  console.log(
    "================================",
  );
  console.log(
    `Task: ${task.id}`,
  );
  console.log(
    `Repository: ${repositoryName(task)}`,
  );
  console.log(
    runState.pullRequestNumber !==
      null
      ? `PR: #${runState.pullRequestNumber}`
      : "PR: pending creation",
  );
  console.log(
    `Branch: ${task.workingBranch}`,
  );
  console.log(
    `Workspace: ${task.workspace}`,
  );
  console.log(
    "================================",
  );

  while (
    runState.workflowState !==
      "DONE" &&
    runState.workflowState !==
      "FAILED" &&
    runState.workflowState !==
      "BLOCKED" &&
    runState.workflowState !==
      "PAUSED" &&
    runState.workflowState !==
      "CANCELLED"
  ) {
    if (
      runState.activeStage === null
    ) {
      if (
        runState.controlSignal ===
        "CANCEL_REQUESTED"
      ) {
        runState = saveState(
          options.store,
          {
            ...runState,
            workflowState:
              "CANCELLED",
            cancelledFromState:
              runState.workflowState,
            controlSignal: "NONE",
          },
        );

        console.log(
          `\nCancel requested: stopping before the next stage. Final state: CANCELLED (from ${runState.cancelledFromState}).`,
        );

        break;
      }

      if (
        runState.controlSignal ===
        "PAUSE_REQUESTED"
      ) {
        runState = saveState(
          options.store,
          {
            ...runState,
            pausedFromState:
              runState.workflowState,
            workflowState: "PAUSED",
            controlSignal: "NONE",
          },
        );

        console.log(
          `\nPause requested: stopping before the next stage. Final state: PAUSED (from ${runState.pausedFromState}).`,
        );

        break;
      }
    }

    console.log(
      "\n==============================",
    );
    console.log(
      `State: ${runState.workflowState}`,
    );

    const displayedCycle =
      runState.workflowState ===
        "IMPLEMENTING" &&
      runState.activeStage !==
        "IMPLEMENTATION"
        ? runState
            .implementationCycle +
          1
        : runState
            .implementationCycle;

    console.log(
      `Implementation cycle: ${displayedCycle}`,
    );
    console.log(
      "==============================\n",
    );

    if (
      runState.workflowState ===
      "PREPARING"
    ) {
      if (
        runState.activeStage !==
        "PREPARATION"
      ) {
        runState =
          saveState(
            options.store,
            {
              ...runState,
              preparationAttempt:
                runState
                  .preparationAttempt +
                1,
              activeStage:
                "PREPARATION",
              activeConversationId:
                null,
            },
          );
      }

      const preparationResponse =
        await runAgentStage(
          options,
          runState,
          "PREPARATION",
          buildPreparationMessage(
            task,
          ),
        );

      runState =
        loadSavedState(
          options.store,
          task.id,
        );

      console.log(
        "--- Preparation response ---\n",
      );
      console.log(
        preparationResponse,
      );

      const preparation =
        persistFailedOnError(
          options.store,
          runState,
          () =>
            parsePreparationResult(
              preparationResponse,
            ),
        );

      if (
        preparation.status ===
        "BLOCKED"
      ) {
        runState =
          saveState(
            options.store,
            {
              ...runState,
              workflowState:
                "BLOCKED",
              blockReason:
                preparation.reason,
              failureKind: null,
              failureMessage:
                null,
              activeStage: null,
              activeConversationId:
                null,
            },
          );

        console.log(
          `\nPreparation: BLOCKED (${preparation.reason ?? "no reason"})`,
        );

        break;
      }

      runState =
        saveState(
          options.store,
          {
            ...runState,
            workflowState:
              "IMPLEMENTING",
            blockReason: null,
            failureKind: null,
            failureMessage: null,
            activeStage: null,
            activeConversationId:
              null,
          },
        );

      console.log(
        "\nPreparation: READY",
      );
      console.log(
        `Next state: ${runState.workflowState}`,
      );

      continue;
    }

    if (
      runState.workflowState ===
      "IMPLEMENTING"
    ) {
      if (
        runState.activeStage !==
        "IMPLEMENTATION"
      ) {
        runState =
          saveState(
            options.store,
            {
              ...runState,
              implementationCycle:
                runState
                  .implementationCycle +
                1,
              activeStage:
                "IMPLEMENTATION",
              activeConversationId:
                null,
            },
          );
      }

      const implementationResponse =
        await runAgentStage(
          options,
          runState,
          "IMPLEMENTATION",
          buildImplementationMessage(
            task,
            runState
              .reviewerFeedback,
            runState
              .pullRequestNumber,
          ),
        );

      runState =
        loadSavedState(
          options.store,
          task.id,
        );

      console.log(
        "--- Implementer response ---\n",
      );
      console.log(
        implementationResponse,
      );

      const implementationResult =
        persistFailedOnError(
          options.store,
          runState,
          () =>
            parseImplementationResult(
              implementationResponse,
            ),
      );

      if (
        implementationResult.status ===
        "BLOCKED_EXTERNAL"
      ) {
        runState = saveState(
          options.store,
          {
            ...runState,
            workflowState: "BLOCKED",
            blockReason:
              implementationResult.reason ??
              null,
            lastBlockerKey:
              implementationResult
                .blockerKey ?? null,
            failureKind: null,
            failureMessage: null,
            activeStage: null,
            activeConversationId: null,
          },
        );

        console.log(
          `\nImplementation: BLOCKED_EXTERNAL (${implementationResult.reason ?? "no reason"})`,
        );

        break;
      }

      try {
        if (
          implementationResult
            .status ===
          "NO_CHANGES_REQUIRED"
        ) {
          const baseSha =
            await validateNoChangesRequired(
              task,
            );

          runState =
            saveState(
              options.store,
              {
                ...runState,
                pullRequestNumber: null,
                noChangesBaseSha:
                  baseSha,
              },
            );

          runState =
            saveState(
              options.store,
              {
                ...runState,
                reviewerFeedback:
                  null,
                workflowState:
                  "REVIEWING",
                failureKind: null,
                failureMessage: null,
                activeStage: null,
                activeConversationId:
                  null,
              },
            );

          continue;
        }

        if (
          github
            .ensureBranchPublished !==
          undefined
        ) {
          await github
            .ensureBranchPublished({
              owner:
                task.repository
                  .owner,
              repo:
                task.repository
                  .name,
              workspace:
                task.workspace,
              branch:
                task.workingBranch,
            });
        }

        let resolvedPullRequestNumber =
          implementationResult
            .pullRequestNumber ??
          runState
            .pullRequestNumber;

        if (
          github
            .ensurePullRequest !==
          undefined
        ) {
          const pullRequest =
            await github
              .ensurePullRequest({
                owner:
                  task.repository
                    .owner,
                repo:
                  task.repository
                    .name,
                baseBranch:
                  task.baseBranch,
                headBranch:
                  task.workingBranch,
                title:
                  pullRequestTitle(
                    task,
                  ),
                body:
                  pullRequestBody(
                    task,
                  ),
              });

          if (
            implementationResult
              .pullRequestNumber !==
              undefined &&
            implementationResult
              .pullRequestNumber !==
              pullRequest.number
          ) {
            throw new Error(
              `Implementer reported PR #${implementationResult.pullRequestNumber}, but orchestrator resolved PR #${pullRequest.number}.`,
            );
          }

          resolvedPullRequestNumber =
            pullRequest.number;
        }

        if (
          resolvedPullRequestNumber ===
            null ||
          resolvedPullRequestNumber ===
            undefined
        ) {
          throw new Error(
            "Implementation finished without a Pull Request number and the GitHub client cannot create one.",
          );
        }

        runState =
          saveState(
            options.store,
            {
              ...runState,
              pullRequestNumber:
                resolvedPullRequestNumber,
              noChangesBaseSha:
                null,
            },
          );
      } catch (
        error: unknown
      ) {
        persistFailed(
          options.store,
          runState,
          "WORKFLOW",
          errorMessage(error),
          false,
        );

        throw error;
      }

      task.pullRequestNumber =
        runState
          .pullRequestNumber ??
        undefined;

      runState =
        saveState(
          options.store,
          {
            ...runState,
            reviewerFeedback:
              null,
            workflowState:
              "REVIEWING",
            failureKind: null,
            failureMessage: null,
            activeStage: null,
            activeConversationId:
              null,
          },
        );

      continue;
    }

    if (
      runState.workflowState ===
      "REVIEWING"
    ) {
      if (
        runState
          .pullRequestNumber ===
          null &&
        runState
          .noChangesBaseSha ===
          null
      ) {
        runState =
          persistFailed(
            options.store,
            runState,
            "WORKFLOW",
            "Review cannot start without a Pull Request number.",
            false,
          );

        throw new Error(
          "Review cannot start without a Pull Request number.",
        );
      }

      if (
        runState
          .noChangesBaseSha !==
        null
      ) {
        let baseSha: string;

        try {
          baseSha =
            await validateNoChangesRequired(
              task,
              runState
                .noChangesBaseSha,
            );
        } catch (
          error: unknown
        ) {
          persistFailed(
            options.store,
            runState,
            "WORKFLOW",
            errorMessage(error),
            false,
          );

          throw error;
        }

        if (
          runState.reviewHeadSha !==
            baseSha ||
          runState.activeStage !==
            "REVIEW"
        ) {
          runState =
            saveState(
              options.store,
              {
                ...runState,
                reviewAttempt:
                  runState
                    .reviewAttempt +
                  1,
                reviewHeadSha:
                  baseSha,
                approvedHeadSha:
                  null,
                activeStage: null,
                activeConversationId:
                  null,
                reviewConversationId:
                  null,
              },
            );
        }

        const reviewerResponse =
          await runAgentStage(
            options,
            runState,
            "REVIEW",
            buildNoChangesReviewMessage(
              task,
              runState
                .reviewHeadSha ??
                baseSha,
            ),
          );

        runState =
          loadSavedState(
            options.store,
            task.id,
          );

        console.log(
          "--- Reviewer response ---\n",
        );
        console.log(
          reviewerResponse,
        );

        const outcome =
          persistFailedOnError(
            options.store,
            runState,
            () =>
              parseReviewOutcome(
                reviewerResponse,
              ),
          );

        const followUp =
          determineReviewFollowUp(
            task,
            runState,
            outcome,
            {
              noChangesRequired:
                true,
            },
          );

        runState =
          saveState(
            options.store,
            {
              ...runState,
              lastReviewerVerdict:
                outcome.verdict,
              reviewerFeedback:
                outcome.verdict ===
                "CHANGES_REQUESTED"
                  ? reviewerResponse
                  : runState
                      .reviewerFeedback,
              workflowState:
                followUp.nextState,
              blockReason:
                followUp.blockReason,
              lastBlockerKey:
                followUp.lastBlockerKey,
              repeatedBlockerCount:
                followUp.repeatedBlockerCount,
              noChangesBaseSha:
                outcome.verdict ===
                "APPROVED"
                  ? runState
                      .noChangesBaseSha
                  : null,
              approvedHeadSha: null,
              mergeCommitSha: null,
              failureKind: null,
              failureMessage: null,
              activeStage: null,
              activeConversationId:
                null,
            },
          );

        console.log(
          `\nVerdict: ${outcome.verdict}`,
        );
        console.log(
          `Next state: ${runState.workflowState}`,
        );

        continue;
      }

      const pullRequestNumber =
        runState
          .pullRequestNumber;

      if (
        pullRequestNumber ===
        null
      ) {
        throw new Error(
          "Review cannot start without a Pull Request number.",
        );
      }

      const pullRequest =
        await getValidatedPullRequest(
          options,
          github,
          runState,
          pullRequestNumber,
        );

      if (
        runState.reviewHeadSha !==
          pullRequest.headRefOid ||
        runState.activeStage !==
          "REVIEW"
      ) {
        runState =
          saveState(
            options.store,
            {
              ...runState,
              reviewAttempt:
                runState
                  .reviewAttempt +
                1,
              reviewHeadSha:
                pullRequest
                  .headRefOid,
              approvedHeadSha:
                null,
              activeStage: null,
              activeConversationId:
                null,
              reviewConversationId:
                null,
            },
          );
      }

      const reviewerResponse =
        await runAgentStage(
          options,
          runState,
          "REVIEW",
          buildReviewMessage(
            task,
            pullRequestNumber,
            runState
              .reviewHeadSha ??
              pullRequest
                .headRefOid,
          ),
        );

      runState =
        loadSavedState(
          options.store,
          task.id,
        );

      console.log(
        "--- Reviewer response ---\n",
      );
      console.log(
        reviewerResponse,
      );

      const outcome =
        persistFailedOnError(
          options.store,
          runState,
          () =>
            parseReviewOutcome(
              reviewerResponse,
            ),
        );

      const followUp =
        determineReviewFollowUp(
          task,
          runState,
          outcome,
        );

      if (
        outcome.verdict ===
        "APPROVED"
      ) {
        const refreshedPullRequest =
          await getValidatedPullRequest(
            options,
            github,
            runState,
            pullRequestNumber,
          );

        if (
          refreshedPullRequest
            .headRefOid !==
          runState.reviewHeadSha
        ) {
          runState =
            saveState(
              options.store,
              {
                ...runState,
                lastReviewerVerdict:
                  outcome.verdict,
                workflowState:
                  "REVIEWING",
                reviewHeadSha:
                  null,
                approvedHeadSha:
                  null,
                activeStage: null,
                activeConversationId:
                  null,
                reviewConversationId:
                  null,
              },
            );

          continue;
        }
      }

      runState =
        saveState(
          options.store,
          {
            ...runState,
            lastReviewerVerdict:
              outcome.verdict,
            reviewerFeedback:
              outcome.verdict ===
              "CHANGES_REQUESTED"
                ? reviewerResponse
                : runState
                    .reviewerFeedback,
            workflowState:
              followUp.nextState,
            blockReason:
              followUp.blockReason,
            lastBlockerKey:
              followUp.lastBlockerKey,
            repeatedBlockerCount:
              followUp.repeatedBlockerCount,
            approvedHeadSha:
              outcome.verdict ===
              "APPROVED"
                ? runState
                    .reviewHeadSha
                : runState
                    .approvedHeadSha,
            failureKind: null,
            failureMessage: null,
            activeStage: null,
            activeConversationId:
              null,
          },
        );

      console.log(
        `\nVerdict: ${outcome.verdict}`,
      );
      console.log(
        `Next state: ${runState.workflowState}`,
      );

      continue;
    }

    if (
      runState.workflowState ===
      "MERGING"
    ) {
      runState =
        await mergeApprovedPullRequest(
          options,
          github,
          runState,
        );

      continue;
    }
  }

  console.log(
    "\n==============================",
  );
  console.log(
    `TASK: ${task.id}`,
  );
  console.log(
    `WORKFLOW FINISHED: ${runState.workflowState}`,
  );

  if (
    runState.blockReason
  ) {
    console.log(
      `BLOCKED REASON: ${runState.blockReason}`,
    );
  }

  console.log(
    "==============================",
  );

  return runState;
}

interface ReviewFollowUp {
  nextState: WorkflowState;
  blockReason: string | null;
  lastBlockerKey: string | null;
  repeatedBlockerCount: number;
}

function determineReviewFollowUp(
  task: WorkflowTask,
  runState: RunState,
  outcome: ReviewOutcome,
  options: {
    noChangesRequired?: boolean;
  } = {},
): ReviewFollowUp {
  if (
    outcome.verdict ===
    "BLOCKED_EXTERNAL"
  ) {
    return {
      nextState: "BLOCKED",
      blockReason:
        outcome.reason,
      lastBlockerKey:
        outcome.blockerKey,
      repeatedBlockerCount: 0,
    };
  }

  if (
    outcome.verdict ===
    "CHANGES_REQUESTED"
  ) {
    const threshold =
      task
        .repeatedBlockerThreshold ??
      DEFAULT_REPEATED_BLOCKER_THRESHOLD;

    const repeatedBlockerCount =
      outcome.blockerKey === null
        ? 0
        : outcome.blockerKey ===
            runState.lastBlockerKey
          ? runState
              .repeatedBlockerCount +
            1
          : 1;

    if (
      outcome.blockerKey !== null &&
      repeatedBlockerCount >=
        threshold
    ) {
      return {
        nextState: "BLOCKED",
        blockReason:
          `Blocker '${outcome.blockerKey}' repeated ${repeatedBlockerCount} consecutive review cycles (threshold ${threshold}).`,
        lastBlockerKey:
          outcome.blockerKey,
        repeatedBlockerCount,
      };
    }

    if (
      task.maxReviewCycles !==
        undefined &&
      runState
        .implementationCycle >=
        task.maxReviewCycles
    ) {
      return {
        nextState: "BLOCKED",
        blockReason:
          `Reached maxReviewCycles=${task.maxReviewCycles} without reviewer approval.`,
        lastBlockerKey:
          outcome.blockerKey,
        repeatedBlockerCount,
      };
    }

    return {
      nextState: "IMPLEMENTING",
      blockReason: null,
      lastBlockerKey:
        outcome.blockerKey,
      repeatedBlockerCount,
    };
  }

  return {
    nextState:
      nextStateAfterReview(
        outcome.verdict,
        options,
      ),
    blockReason: null,
    lastBlockerKey: null,
    repeatedBlockerCount: 0,
  };
}

async function mergeApprovedPullRequest(
  options: RunWorkflowOptions,
  github: GitHubClient,
  runState: RunState,
): Promise<RunState> {
  if (
    runState.pullRequestNumber ===
    null
  ) {
    persistFailed(
      options.store,
      runState,
      "WORKFLOW",
      "Merge cannot start without a Pull Request number.",
      false,
    );

    throw new Error(
      "Merge cannot start without a Pull Request number.",
    );
  }

  if (
    runState.approvedHeadSha ===
    null
  ) {
    persistFailed(
      options.store,
      runState,
      "WORKFLOW",
      "Merge cannot start without an approved head SHA.",
      false,
    );

    throw new Error(
      "Merge cannot start without an approved head SHA.",
    );
  }

  const pullRequest =
    await getValidatedPullRequest(
      options,
      github,
      runState,
      runState
        .pullRequestNumber,
      {
        allowMerged: true,
      },
    );

  if (
    pullRequest.merged
  ) {
    if (
      pullRequest.headRefOid !==
      runState.approvedHeadSha
    ) {
      persistFailed(
        options.store,
        runState,
        "WORKFLOW",
        `Merged head ${pullRequest.headRefOid} differs from approved ${runState.approvedHeadSha}.`,
        false,
      );

      throw new Error(
        `Pull Request #${pullRequest.number} is merged with head ${pullRequest.headRefOid}, expected approved head ${runState.approvedHeadSha}.`,
      );
    }

    return saveState(
      options.store,
      {
        ...runState,
        workflowState:
          "DONE",
        mergeCommitSha:
          pullRequest
            .mergeCommitSha,
        failureKind: null,
        failureMessage: null,
        activeStage: null,
        activeConversationId:
          null,
      },
    );
  }

  if (
    pullRequest.state !==
    "OPEN"
  ) {
    persistFailed(
      options.store,
      runState,
      "WORKFLOW",
      `Pull Request #${pullRequest.number} is not open.`,
      false,
    );

    throw new Error(
      `Pull Request #${pullRequest.number} must be open before merge.`,
    );
  }

  if (
    pullRequest.headRefOid !==
    runState.approvedHeadSha
  ) {
    return saveState(
      options.store,
      {
        ...runState,
        workflowState:
          "REVIEWING",
        reviewHeadSha: null,
        approvedHeadSha: null,
        activeStage: null,
        activeConversationId:
          null,
        reviewConversationId:
          null,
      },
    );
  }

  try {
    const mergeResult =
      await github
        .mergePullRequest({
          owner:
            taskOwner(
              options.task,
            ),
          repo:
            options.task
              .repository.name,
          pullRequestNumber:
            runState
              .pullRequestNumber,
          expectedHeadSha:
            runState
              .approvedHeadSha,
        });

    const confirmedPullRequest =
      await github
        .getPullRequest({
          owner:
            taskOwner(
              options.task,
            ),
          repo:
            options.task
              .repository.name,
          pullRequestNumber:
            runState
              .pullRequestNumber,
        });

    validatePullRequestForTask(
      options.task,
      confirmedPullRequest,
      {
        allowMerged: true,
      },
    );

    if (
      !confirmedPullRequest
        .merged
    ) {
      persistFailed(
        options.store,
        runState,
        "WORKFLOW",
        `Pull Request #${runState.pullRequestNumber} was not confirmed as merged.`,
        false,
      );

      throw new Error(
        `Pull Request #${runState.pullRequestNumber} was not confirmed as merged.`,
      );
    }

    if (
      confirmedPullRequest
        .headRefOid !==
      runState
        .approvedHeadSha
    ) {
      persistFailed(
        options.store,
        runState,
        "WORKFLOW",
        "Merged head changed after approval.",
        false,
      );

      throw new Error(
        `Pull Request #${runState.pullRequestNumber} merged with head ${confirmedPullRequest.headRefOid}, expected ${runState.approvedHeadSha}.`,
      );
    }

    return saveState(
      options.store,
      {
        ...runState,
        workflowState:
          "DONE",
        mergeCommitSha:
          mergeResult
            .mergeCommitSha,
        failureKind: null,
        failureMessage: null,
        activeStage: null,
        activeConversationId:
          null,
      },
    );
  } catch (
    error: unknown
  ) {
    let refreshedPullRequest:
      PullRequestDetails;

    try {
      refreshedPullRequest =
        await getValidatedPullRequest(
          options,
          github,
          runState,
          runState
            .pullRequestNumber,
          {
            allowMerged: true,
          },
        );
    } catch {
      throw error;
    }

    if (
      refreshedPullRequest
        .headRefOid !==
      runState
        .approvedHeadSha
    ) {
      return saveState(
        options.store,
        {
          ...runState,
          workflowState:
            "REVIEWING",
          reviewHeadSha: null,
          approvedHeadSha:
            null,
          activeStage: null,
          activeConversationId:
            null,
          reviewConversationId:
            null,
        },
      );
    }

    persistFailed(
      options.store,
      runState,
      "WORKFLOW",
      errorMessage(error),
      false,
    );

    throw error;
  }
}

async function getValidatedPullRequest(
  options: RunWorkflowOptions,
  github: GitHubClient,
  runState: RunState,
  pullRequestNumber: number,
  validationOptions: {
    allowMerged?: boolean;
  } = {},
): Promise<PullRequestDetails> {
  try {
    const pullRequest =
      await github
        .getPullRequest({
          owner:
            taskOwner(
              options.task,
            ),
          repo:
            options.task
              .repository.name,
          pullRequestNumber,
        });

    validatePullRequestForTask(
      options.task,
      pullRequest,
      validationOptions,
    );

    return pullRequest;
  } catch (
    error: unknown
  ) {
    persistFailed(
      options.store,
      runState,
      "WORKFLOW",
      errorMessage(error),
      false,
    );

    throw error;
  }
}

function validatePullRequestForTask(
  task: WorkflowTask,
  pullRequest:
    PullRequestDetails,
  options: {
    allowMerged?: boolean;
  } = {},
): void {
  if (
    pullRequest
      .headRepositoryOwner !==
      task.repository.owner ||
    pullRequest
      .headRepositoryName !==
      task.repository.name
  ) {
    throw new Error(
      `Pull Request #${pullRequest.number} belongs to ${pullRequest.headRepositoryOwner}/${pullRequest.headRepositoryName}, expected ${repositoryName(task)}.`,
    );
  }

  if (
    pullRequest.baseRefName !==
    task.baseBranch
  ) {
    throw new Error(
      `Pull Request #${pullRequest.number} base is ${pullRequest.baseRefName}, expected ${task.baseBranch}.`,
    );
  }

  if (
    pullRequest.headRefName !==
    task.workingBranch
  ) {
    throw new Error(
      `Pull Request #${pullRequest.number} head is ${pullRequest.headRefName}, expected ${task.workingBranch}.`,
    );
  }

  if (
    !options.allowMerged &&
    pullRequest.merged
  ) {
    throw new Error(
      `Pull Request #${pullRequest.number} is already merged.`,
    );
  }
}

async function validateNoChangesRequired(
  task: WorkflowTask,
  expectedBaseSha?: string,
): Promise<string> {
  const baseRef =
    `origin/${task.baseBranch}`;

  await git(
    task.workspace,
    [
      "fetch",
      "origin",
      task.baseBranch,
    ],
  );

  const status =
    await git(
      task.workspace,
      [
        "status",
        "--porcelain",
      ],
    );

  if (status.trim() !== "") {
    throw new Error(
      "NO_CHANGES_REQUIRED is invalid because the worktree has local changes.",
    );
  }

  const headSha =
    (
      await git(
        task.workspace,
        [
          "rev-parse",
          "HEAD",
        ],
      )
    ).trim();

  const baseSha =
    (
      await git(
        task.workspace,
        [
          "rev-parse",
          baseRef,
        ],
      )
    ).trim();

  if (
    expectedBaseSha !== undefined &&
    baseSha !== expectedBaseSha
  ) {
    throw new Error(
      `NO_CHANGES_REQUIRED base SHA changed from ${expectedBaseSha} to ${baseSha}.`,
    );
  }

  const aheadCount =
    Number(
      (
        await git(
          task.workspace,
          [
            "rev-list",
            "--count",
            `${baseRef}..HEAD`,
          ],
        )
      ).trim(),
    );

  if (
    !Number.isInteger(aheadCount) ||
    aheadCount > 0
  ) {
    throw new Error(
      "NO_CHANGES_REQUIRED is invalid because HEAD has commits ahead of the base branch.",
    );
  }

  if (headSha !== baseSha) {
    throw new Error(
      `NO_CHANGES_REQUIRED is invalid because HEAD ${headSha} is not origin/${task.baseBranch} ${baseSha}.`,
    );
  }

  await git(
    task.workspace,
    [
      "diff",
      "--quiet",
      baseRef,
      "HEAD",
    ],
  );

  return baseSha;
}

async function git(
  workspace: string,
  args: string[],
): Promise<string> {
  const { stdout } =
    await execFileAsync(
      "git",
      [
        "-C",
        workspace,
        ...args,
      ],
      {
        encoding: "utf8",
      },
    );

  return stdout;
}

function loadOrCreateRunState(
  options: RunWorkflowOptions,
): RunState {
  const existing =
    options.store.load(
      options.task.id,
    );

  if (
    existing !== null
  ) {
    if (
      existing.workflowState ===
      "BLOCKED"
    ) {
      console.log(
        `Resuming blocked task ${options.task.id} from PREPARING.`,
      );

      return saveState(
        options.store,
        {
          ...existing,
          workflowState:
            "PREPARING",
          blockReason: null,
          activeStage: null,
          activeConversationId:
            null,
        },
      );
    }

    if (
      existing.workflowState ===
      "PAUSED"
    ) {
      const resumedState =
        existing.pausedFromState ??
        "PREPARING";

      console.log(
        `Resuming paused task ${options.task.id} into ${resumedState}.`,
      );

      return saveState(
        options.store,
        {
          ...existing,
          workflowState:
            resumedState,
          pausedFromState: null,
          controlSignal: "NONE",
        },
      );
    }

    if (
      existing.workflowState ===
        "FAILED" &&
      (
        existing.failureKind ===
          "TRANSIENT" ||
        existing.failureKind ===
          "RESOURCE_LIMIT"
      ) &&
      existing.activeStage !==
        null &&
      existing
        .activeConversationId !==
        null
    ) {
      console.log(
        `Resuming ${existing.failureKind === "RESOURCE_LIMIT" ? "resource-limited" : "transiently failed"} task ${options.task.id} using conversation ${existing.activeConversationId}.`,
      );

      return saveState(
        options.store,
        {
          ...existing,
          workflowState:
            workflowStateForStage(
              existing
                .activeStage,
            ),
          failureKind: null,
          failureMessage: null,
        },
      );
    }

    console.log(
      `Resuming persisted RunState for task ${options.task.id}.`,
    );

    return existing;
  }

  const defaultInitialState:
    WorkflowState =
      options.task
        .pullRequestNumber ===
      undefined
        ? "PREPARING"
        : "IMPLEMENTING";

  const workflowState =
    options
      .initialStateOverride ??
    defaultInitialState;

  return saveState(
    options.store,
    createInitialRunState(
      options.task.id,
      workflowState,
      options.task
        .pullRequestNumber ??
        null,
    ),
  );
}

async function runAgentStage(
  options: RunWorkflowOptions,
  runState: RunState,
  stage: WorkflowStage,
  message: string,
): Promise<string> {
  try {
    let conversationId =
      getStageConversationId(
        runState,
        stage,
      );

    let conversation:
      | {
          id: string;
          execution_status: string;
        }
      | null = null;

    if (
      conversationId === null
    ) {
      conversationId =
        deterministicConversationId(
          runState,
          stage,
        );

      runState =
        saveState(
          options.store,
          {
            ...runState,
            activeStage:
              stage,
            activeConversationId:
              conversationId,
            ...stageConversationPatch(
              stage,
              conversationId,
            ),
            ...stageExecutionPatch(options, runState, stage, conversationId),
          },
        );

      const createdConversation =
        await options.client
          .createConversation({
            workspace:
              options.task
                .workspace,
            agentProfileId: agentProfileForStage(options, stage),
            message,
            conversationId,
          });

      assertConversationId(
        createdConversation.id,
        conversationId,
      );

      conversation = {
        id:
          createdConversation.id,
        execution_status:
          createdConversation
            .execution_status ??
          "running",
      };

      console.log(
        `Conversation: ${conversationId}`,
      );
    } else {
      runState =
        saveState(
          options.store,
          {
            ...runState,
            activeStage:
              stage,
            activeConversationId:
              conversationId,
          },
        );

      console.log(
        `Resuming conversation: ${conversationId}`,
      );
    }

    if (
      conversation === null
    ) {
      conversation =
        await getOrCreateConversation(
          options,
          conversationId,
          stage,
          message,
        );
    }

    if (
      conversation
        .execution_status !==
      "finished"
    ) {
      await options.client
        .waitUntilFinished(
          conversationId,
          {
            pollIntervalMs:
              options
                .pollIntervalMs ??
              1000,
          },
        );
    }

    return options.client
      .getFinalResponse(
        conversationId,
      );
  } catch (
    error: unknown
  ) {
    if (
      error instanceof
      OpenHandsTransientError
    ) {
      persistFailed(
        options.store,
        runState,
        "TRANSIENT",
        error.message,
        true,
      );
    } else if (
      error instanceof
      ConversationTerminalError
    ) {
      const detail =
        await safeGetTerminalErrorDetail(
          options.client,
          error.conversationId,
        );

      persistFailed(
        options.store,
        runState,
        isResourceLimitEvidence(
          detail,
        )
          ? "RESOURCE_LIMIT"
          : "TERMINAL",
        error.message,
        true,
      );
    } else {
      persistFailed(
        options.store,
        runState,
        "WORKFLOW",
        errorMessage(error),
        false,
      );
    }

    throw error;
  }
}

async function getOrCreateConversation(
  options: RunWorkflowOptions,
  conversationId: string,
  stage: WorkflowStage,
  message: string,
): Promise<{
  id: string;
  execution_status: string;
}> {
  try {
    return await options.client
      .getConversation(
        conversationId,
      );
  } catch (
    error: unknown
  ) {
    if (
      !isMissingConversationError(
        error,
      )
    ) {
      throw error;
    }
  }

  const conversation =
    await options.client
      .createConversation({
        workspace:
          options.task
            .workspace,
        agentProfileId: agentProfileForStage(options, stage),
        message,
        conversationId,
      });

  assertConversationId(
    conversation.id,
    conversationId,
  );

  return {
    id:
      conversation.id,
    execution_status:
      "running",
  };
}

function agentProfileForStage(options: RunWorkflowOptions, stage: WorkflowStage): string {
  return options.stageAgentProfileIds?.[stage] ?? options.agentProfileId;
}

function stageExecutionPatch(options: RunWorkflowOptions, state: RunState, stage: WorkflowStage, conversationId: string): Partial<RunState> {
  if (state.stageExecutions[stage] !== undefined) return {};
  const execution = options.stageExecutions?.[stage];
  if (!execution) return {};
  return { stageExecutions: { ...state.stageExecutions, [stage]: { ...execution, conversationId, reviewedSha: null, approvedSha: null } } };
}

function assertConversationId(
  actual: string,
  expected: string,
): void {
  if (
    actual !== expected
  ) {
    throw new Error(
      `OpenHands returned conversation ${actual}, expected ${expected}.`,
    );
  }
}

function isMissingConversationError(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "OpenHands API 404",
    )
  );
}

function deterministicConversationId(
  runState: RunState,
  stage: WorkflowStage,
): string {
  const attempt =
    stage === "PREPARATION"
      ? String(
          runState
            .preparationAttempt,
        )
      : stage === "REVIEW"
        ? String(
            runState
              .reviewAttempt,
          )
        : "0";

  const source = [
    "oquestador",
    runState.taskId,
    stage,
    String(
      runState
        .implementationCycle,
    ),
    attempt,
  ].join(":");

  const bytes =
    createHash("sha256")
      .update(source)
      .digest()
      .subarray(0, 16);

  bytes[6] =
    (bytes[6]! & 0x0f) |
    0x50;

  bytes[8] =
    (bytes[8]! & 0x3f) |
    0x80;

  const hex =
    bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function getStageConversationId(
  runState: RunState,
  stage: WorkflowStage,
): string | null {
  if (
    runState.activeStage ===
      stage &&
    runState
      .activeConversationId !==
      null
  ) {
    return runState
      .activeConversationId;
  }

  return null;
}

function stageConversationPatch(
  stage: WorkflowStage,
  conversationId: string,
): Partial<
  Pick<
    RunState,
    | "preparationConversationId"
    | "implementationConversationId"
    | "reviewConversationId"
  >
> {
  switch (stage) {
    case "PREPARATION":
      return {
        preparationConversationId:
          conversationId,
      };

    case "IMPLEMENTATION":
      return {
        implementationConversationId:
          conversationId,
      };

    case "REVIEW":
      return {
        reviewConversationId:
          conversationId,
      };
  }
}

function saveState(
  store: RunStateStore,
  state: RunState,
): RunState {
  const reviewExecution = state.stageExecutions.REVIEW;
  const persisted = reviewExecution === undefined
    ? state
    : {
      ...state,
      stageExecutions: {
        ...state.stageExecutions,
        REVIEW: {
          ...reviewExecution,
          reviewedSha: state.reviewHeadSha ?? reviewExecution.reviewedSha,
          approvedSha: state.approvedHeadSha ?? reviewExecution.approvedSha,
        },
      },
    };
  store.save(persisted);

  return loadSavedState(
    store,
    persisted.taskId,
  );
}

function loadSavedState(
  store: RunStateStore,
  taskId: string,
): RunState {
  const loaded =
    store.load(taskId);

  if (
    loaded === null
  ) {
    throw new Error(
      `RunState was not saved for task ${taskId}.`,
    );
  }

  return loaded;
}

function persistFailed(
  store: RunStateStore,
  runState: RunState,
  kind: FailureKind,
  message: string,
  preserveActiveConversation:
    boolean,
): RunState {
  return saveState(
    store,
    {
      ...runState,
      workflowState:
        "FAILED",
      failureKind: kind,
      failureMessage:
        message,
      activeStage:
        preserveActiveConversation
          ? runState
              .activeStage
          : null,
      activeConversationId:
        preserveActiveConversation
          ? runState
              .activeConversationId
          : null,
    },
  );
}

function persistFailedOnError<T>(
  store: RunStateStore,
  runState: RunState,
  action: () => T,
): T {
  try {
    return action();
  } catch (
    error: unknown
  ) {
    persistFailed(
      store,
      runState,
      "WORKFLOW",
      errorMessage(error),
      false,
    );

    throw error;
  }
}

function workflowStateForStage(
  stage: WorkflowStage,
): WorkflowState {
  switch (stage) {
    case "PREPARATION":
      return "PREPARING";

    case "IMPLEMENTATION":
      return "IMPLEMENTING";

    case "REVIEW":
      return "REVIEWING";
  }
}

function pullRequestTitle(
  task: WorkflowTask,
): string {
  const compact =
    task.objective
      .replace(
        /\s+/g,
        " ",
      )
      .trim();

  return compact.length <= 80
    ? compact
    : `${compact.slice(0, 77)}...`;
}

function pullRequestBody(
  task: WorkflowTask,
): string {
  return [
    `Task: ${task.id}`,
    "",
    task.objective,
    "",
    "Created and maintained by oquestador.",
  ].join("\n");
}

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function taskOwner(
  task: WorkflowTask,
): string {
  return task.repository.owner;
}
