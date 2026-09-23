import { createHash } from "node:crypto";

import {
  GhCliGitHubClient,
  type GitHubClient,
  type PullRequestDetails,
} from "./GitHubClient";
import { OpenHandsClient } from "./OpenHandsClient";
import {
  buildImplementationMessage,
  buildPreparationMessage,
  buildReviewMessage,
  repositoryName,
} from "./orchestratorMessages";
import {
  createInitialRunState,
  type RunState,
  RunStateStore,
  type WorkflowStage,
} from "./runState";
import type { WorkflowTask } from "./task";
import { loadWorkflowTask } from "./taskLoader";
import {
  nextStateAfterReview,
  parseImplementationResult,
  parsePreparationResult,
  parseReviewerVerdict,
  type WorkflowState,
} from "./workflow";

interface AgentClient {
  createConversation(options: {
    workspace: string;
    agentProfileId: string;
    message: string;
    conversationId?: string;
  }): Promise<{ id: string }>;

  getConversation(conversationId: string): Promise<{
    id: string;
    execution_status: string;
  }>;

  waitUntilFinished(
    conversationId: string,
    options?: { pollIntervalMs?: number },
  ): Promise<{ id: string; execution_status: string }>;

  getFinalResponse(conversationId: string): Promise<string>;
}

interface RunWorkflowOptions {
  client: AgentClient;
  task: WorkflowTask;
  store: RunStateStore;
  agentProfileId: string;
  initialStateOverride?: WorkflowState;
  pollIntervalMs?: number;
  github?: GitHubClient;
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<RunState> {
  const task = options.task;
  const github = options.github ?? new GhCliGitHubClient();
  let runState = loadOrCreateRunState(options);

  task.pullRequestNumber =
    runState.pullRequestNumber ?? undefined;

  console.log("================================");
  console.log(`Task: ${task.id}`);
  console.log(`Repository: ${repositoryName(task)}`);
  console.log(
    runState.pullRequestNumber !== null
      ? `PR: #${runState.pullRequestNumber}`
      : "PR: pending creation",
  );
  console.log(`Branch: ${task.workingBranch}`);
  console.log("================================");

  while (
    runState.workflowState !== "DONE" &&
    runState.workflowState !== "FAILED"
  ) {
    console.log("\n==============================");
    console.log(`State: ${runState.workflowState}`);
    const displayedCycle =
      runState.workflowState === "IMPLEMENTING" &&
      runState.activeStage !== "IMPLEMENTATION"
        ? runState.implementationCycle + 1
        : runState.implementationCycle;
    console.log(
      `Implementation cycle: ${displayedCycle}`,
    );
    console.log("==============================\n");

    if (runState.workflowState === "PREPARING") {
      const preparationResponse = await runAgentStage(
        options,
        runState,
        "PREPARATION",
        buildPreparationMessage(task),
      );
      runState = loadSavedState(options.store, task.id);

      console.log("--- Preparation response ---\n");
      console.log(preparationResponse);

      runState = persistFailedOnError(
        options.store,
        runState,
        () => {
          parsePreparationResult(preparationResponse);
          return runState;
        },
      );

      runState = saveState(options.store, {
        ...runState,
        workflowState: "IMPLEMENTING",
        activeStage: null,
        activeConversationId: null,
      });

      console.log("\nPreparation: READY");
      console.log(`Next state: ${runState.workflowState}`);

      continue;
    }

    if (runState.workflowState === "IMPLEMENTING") {
      if (runState.activeStage !== "IMPLEMENTATION") {
        runState = saveState(options.store, {
          ...runState,
          implementationCycle:
            runState.implementationCycle + 1,
          activeStage: "IMPLEMENTATION",
          activeConversationId: null,
        });
      }

      const implementationResponse = await runAgentStage(
        options,
        runState,
        "IMPLEMENTATION",
        buildImplementationMessage(
          task,
          runState.reviewerFeedback,
          runState.pullRequestNumber,
        ),
      );
      runState = loadSavedState(options.store, task.id);

      console.log("--- Implementer response ---\n");
      console.log(implementationResponse);

      runState = persistFailedOnError(
        options.store,
        runState,
        () => {
          const implementationResult =
            parseImplementationResult(implementationResponse);

          if (
            implementationResult.pullRequestNumber !== undefined &&
            runState.pullRequestNumber !==
              implementationResult.pullRequestNumber
          ) {
            runState = saveState(options.store, {
              ...runState,
              pullRequestNumber:
                implementationResult.pullRequestNumber,
            });
          }

          if (runState.pullRequestNumber === null) {
            throw new Error(
              "Implementation finished without a Pull Request number.",
            );
          }

          return runState;
        },
      );

      task.pullRequestNumber =
        runState.pullRequestNumber ?? undefined;

      runState = saveState(options.store, {
        ...runState,
        reviewerFeedback: null,
        workflowState: "REVIEWING",
        activeStage: null,
        activeConversationId: null,
      });

      continue;
    }

    if (runState.workflowState === "REVIEWING") {
      if (runState.pullRequestNumber === null) {
        runState = persistFailed(options.store, runState);
        throw new Error(
          "Review cannot start without a Pull Request number.",
        );
      }
      const pullRequestNumber = runState.pullRequestNumber;

      const pullRequest = await getValidatedPullRequest(
        options,
        github,
        runState,
        pullRequestNumber,
      );

      if (
        runState.reviewHeadSha !== pullRequest.headRefOid ||
        runState.activeStage !== "REVIEW"
      ) {
        runState = saveState(options.store, {
          ...runState,
          reviewAttempt: runState.reviewAttempt + 1,
          reviewHeadSha: pullRequest.headRefOid,
          approvedHeadSha: null,
          activeStage: null,
          activeConversationId: null,
          reviewConversationId: null,
        });
      }

      const reviewerResponse = await runAgentStage(
        options,
        runState,
        "REVIEW",
        buildReviewMessage(
          task,
          pullRequestNumber,
          runState.reviewHeadSha ?? pullRequest.headRefOid,
        ),
      );
      runState = loadSavedState(options.store, task.id);

      console.log("--- Reviewer response ---\n");
      console.log(reviewerResponse);

      const result = persistFailedOnError(
        options.store,
        runState,
        () => {
          const verdict =
            parseReviewerVerdict(reviewerResponse);
          const nextState = nextStateAfterReview(verdict);

          return {
            verdict,
            nextState,
          };
        },
      );

      if (result.verdict === "APPROVED") {
        const refreshedPullRequest =
          await getValidatedPullRequest(
            options,
            github,
            runState,
            pullRequestNumber,
          );

        if (
          refreshedPullRequest.headRefOid !== runState.reviewHeadSha
        ) {
          runState = saveState(options.store, {
            ...runState,
            lastReviewerVerdict: result.verdict,
            workflowState: "REVIEWING",
            reviewHeadSha: null,
            approvedHeadSha: null,
            activeStage: null,
            activeConversationId: null,
            reviewConversationId: null,
          });
          continue;
        }
      }

      runState = saveState(options.store, {
        ...runState,
        lastReviewerVerdict: result.verdict,
        reviewerFeedback:
          result.verdict === "CHANGES_REQUESTED"
            ? reviewerResponse
            : runState.reviewerFeedback,
        workflowState: result.nextState,
        approvedHeadSha:
          result.verdict === "APPROVED"
            ? runState.reviewHeadSha
            : runState.approvedHeadSha,
        activeStage: null,
        activeConversationId: null,
      });

      console.log(`\nVerdict: ${result.verdict}`);
      console.log(`Next state: ${runState.workflowState}`);

      continue;
    }

    if (runState.workflowState === "MERGING") {
      runState = await mergeApprovedPullRequest(
        options,
        github,
        runState,
      );
      continue;
    }
  }

  console.log("\n==============================");
  console.log(`TASK: ${task.id}`);
  console.log(
    `WORKFLOW FINISHED: ${runState.workflowState}`,
  );
  console.log("==============================");

  return runState;
}

async function mergeApprovedPullRequest(
  options: RunWorkflowOptions,
  github: GitHubClient,
  runState: RunState,
): Promise<RunState> {
  if (runState.pullRequestNumber === null) {
    persistFailed(options.store, runState);
    throw new Error("Merge cannot start without a Pull Request number.");
  }

  if (runState.approvedHeadSha === null) {
    persistFailed(options.store, runState);
    throw new Error("Merge cannot start without an approved head SHA.");
  }

  const pullRequest = await getValidatedPullRequest(
    options,
    github,
    runState,
    runState.pullRequestNumber,
    { allowMerged: true },
  );

  if (pullRequest.merged) {
    if (pullRequest.headRefOid !== runState.approvedHeadSha) {
      persistFailed(options.store, runState);
      throw new Error(
        `Pull Request #${pullRequest.number} is merged with head ${pullRequest.headRefOid}, expected approved head ${runState.approvedHeadSha}.`,
      );
    }

    return saveState(options.store, {
      ...runState,
      workflowState: "DONE",
      mergeCommitSha: pullRequest.mergeCommitSha,
      activeStage: null,
      activeConversationId: null,
    });
  }

  if (pullRequest.state !== "OPEN") {
    persistFailed(options.store, runState);
    throw new Error(
      `Pull Request #${pullRequest.number} must be open before merge.`,
    );
  }

  if (pullRequest.headRefOid !== runState.approvedHeadSha) {
    return saveState(options.store, {
      ...runState,
      workflowState: "REVIEWING",
      reviewHeadSha: null,
      approvedHeadSha: null,
      activeStage: null,
      activeConversationId: null,
      reviewConversationId: null,
    });
  }

  try {
    const mergeResult = await github.mergePullRequest({
      owner: options.task.repository.owner,
      repo: options.task.repository.name,
      pullRequestNumber: runState.pullRequestNumber,
      expectedHeadSha: runState.approvedHeadSha,
    });

    const confirmedPullRequest = await github.getPullRequest({
      owner: options.task.repository.owner,
      repo: options.task.repository.name,
      pullRequestNumber: runState.pullRequestNumber,
    });
    validatePullRequestForTask(options.task, confirmedPullRequest, {
      allowMerged: true,
    });

    if (!confirmedPullRequest.merged) {
      persistFailed(options.store, runState);
      throw new Error(
        `Pull Request #${runState.pullRequestNumber} was not confirmed as merged.`,
      );
    }

    if (
      confirmedPullRequest.headRefOid !== runState.approvedHeadSha
    ) {
      persistFailed(options.store, runState);
      throw new Error(
        `Pull Request #${runState.pullRequestNumber} merged with head ${confirmedPullRequest.headRefOid}, expected ${runState.approvedHeadSha}.`,
      );
    }

    return saveState(options.store, {
      ...runState,
      workflowState: "DONE",
      mergeCommitSha: mergeResult.mergeCommitSha,
      activeStage: null,
      activeConversationId: null,
    });
  } catch (error: unknown) {
    let refreshedPullRequest: PullRequestDetails;

    try {
      refreshedPullRequest = await getValidatedPullRequest(
        options,
        github,
        runState,
        runState.pullRequestNumber,
        { allowMerged: true },
      );
    } catch {
      throw error;
    }

    if (refreshedPullRequest.headRefOid !== runState.approvedHeadSha) {
      return saveState(options.store, {
        ...runState,
        workflowState: "REVIEWING",
        reviewHeadSha: null,
        approvedHeadSha: null,
        activeStage: null,
        activeConversationId: null,
        reviewConversationId: null,
      });
    }

    persistFailed(options.store, runState);
    throw error;
  }
}

async function getValidatedPullRequest(
  options: RunWorkflowOptions,
  github: GitHubClient,
  runState: RunState,
  pullRequestNumber: number,
  validationOptions: { allowMerged?: boolean } = {},
): Promise<PullRequestDetails> {
  try {
    const pullRequest = await github.getPullRequest({
      owner: options.task.repository.owner,
      repo: options.task.repository.name,
      pullRequestNumber,
    });
    validatePullRequestForTask(
      options.task,
      pullRequest,
      validationOptions,
    );
    return pullRequest;
  } catch (error: unknown) {
    persistFailed(options.store, runState);
    throw error;
  }
}

function validatePullRequestForTask(
  task: WorkflowTask,
  pullRequest: PullRequestDetails,
  options: { allowMerged?: boolean } = {},
): void {
  if (
    pullRequest.headRepositoryOwner !== task.repository.owner ||
    pullRequest.headRepositoryName !== task.repository.name
  ) {
    throw new Error(
      `Pull Request #${pullRequest.number} belongs to ${pullRequest.headRepositoryOwner}/${pullRequest.headRepositoryName}, expected ${repositoryName(task)}.`,
    );
  }

  if (pullRequest.baseRefName !== task.baseBranch) {
    throw new Error(
      `Pull Request #${pullRequest.number} base is ${pullRequest.baseRefName}, expected ${task.baseBranch}.`,
    );
  }

  if (pullRequest.headRefName !== task.workingBranch) {
    throw new Error(
      `Pull Request #${pullRequest.number} head is ${pullRequest.headRefName}, expected ${task.workingBranch}.`,
    );
  }

  if (!options.allowMerged && pullRequest.merged) {
    throw new Error(
      `Pull Request #${pullRequest.number} is already merged.`,
    );
  }
}

function loadOrCreateRunState(
  options: RunWorkflowOptions,
): RunState {
  const existing = options.store.load(options.task.id);

  if (existing !== null) {
    console.log(
      `Resuming persisted RunState for task ${options.task.id}.`,
    );
    return existing;
  }

  const defaultInitialState: WorkflowState =
    options.task.pullRequestNumber === undefined
      ? "PREPARING"
      : "IMPLEMENTING";
  const workflowState =
    options.initialStateOverride ?? defaultInitialState;

  const runState = createInitialRunState(
    options.task.id,
    workflowState,
    options.task.pullRequestNumber ?? null,
  );

  return saveState(options.store, runState);
}

async function runAgentStage(
  options: RunWorkflowOptions,
  runState: RunState,
  stage: WorkflowStage,
  message: string,
): Promise<string> {
  try {
    let conversationId = getStageConversationId(
      runState,
      stage,
    );

    if (conversationId === null) {
      conversationId = deterministicConversationId(
        runState,
        stage,
      );

      runState = saveState(options.store, {
        ...runState,
        activeStage: stage,
        activeConversationId: conversationId,
        ...stageConversationPatch(stage, conversationId),
      });

      const conversation =
        await options.client.createConversation({
          workspace: options.task.workspace,
          agentProfileId: options.agentProfileId,
          message,
          conversationId,
        });

      assertConversationId(
        conversation.id,
        conversationId,
      );

      console.log(`Conversation: ${conversationId}`);
    } else {
      runState = saveState(options.store, {
        ...runState,
        activeStage: stage,
        activeConversationId: conversationId,
      });

      console.log(
        `Resuming conversation: ${conversationId}`,
      );
    }

    const conversation = await getOrCreateConversation(
      options,
      conversationId,
      message,
    );

    if (conversation.execution_status !== "finished") {
      await options.client.waitUntilFinished(conversationId, {
        pollIntervalMs: options.pollIntervalMs ?? 1000,
      });
    }

    return options.client.getFinalResponse(conversationId);
  } catch (error: unknown) {
    runState = persistFailed(options.store, runState);

    throw error;
  }
}

async function getOrCreateConversation(
  options: RunWorkflowOptions,
  conversationId: string,
  message: string,
): Promise<{ id: string; execution_status: string }> {
  try {
    return await options.client.getConversation(conversationId);
  } catch (error: unknown) {
    if (!isMissingConversationError(error)) {
      throw error;
    }
  }

  const conversation = await options.client.createConversation({
    workspace: options.task.workspace,
    agentProfileId: options.agentProfileId,
    message,
    conversationId,
  });

  assertConversationId(conversation.id, conversationId);

  return options.client.getConversation(conversationId);
}

function assertConversationId(
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `OpenHands returned conversation ${actual}, expected ${expected}.`,
    );
  }
}

function isMissingConversationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("OpenHands API 404")
  );
}

function deterministicConversationId(
  runState: RunState,
  stage: WorkflowStage,
): string {
  const source = [
    "oquestador",
    runState.taskId,
    stage,
    String(runState.implementationCycle),
    stage === "REVIEW" ? String(runState.reviewAttempt) : "0",
  ].join(":");
  const bytes = createHash("sha256")
    .update(source)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

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
    runState.activeStage === stage &&
    runState.activeConversationId !== null
  ) {
    return runState.activeConversationId;
  }

  return null;
}

function stageConversationPatch(
  stage: WorkflowStage,
  conversationId: string,
): Partial<Pick<
  RunState,
  | "preparationConversationId"
  | "implementationConversationId"
  | "reviewConversationId"
>> {
  switch (stage) {
    case "PREPARATION":
      return {
        preparationConversationId: conversationId,
      };
    case "IMPLEMENTATION":
      return {
        implementationConversationId: conversationId,
      };
    case "REVIEW":
      return {
        reviewConversationId: conversationId,
      };
  }
}

function saveState(
  store: RunStateStore,
  state: RunState,
): RunState {
  store.save(state);
  return loadSavedState(store, state.taskId);
}

function loadSavedState(
  store: RunStateStore,
  taskId: string,
): RunState {
  const loaded = store.load(taskId);

  if (loaded === null) {
    throw new Error(
      `RunState was not saved for task ${taskId}.`,
    );
  }

  return loaded;
}

function persistFailed(
  store: RunStateStore,
  runState: RunState,
): RunState {
  return saveState(store, {
    ...runState,
    workflowState: "FAILED",
    activeStage: null,
    activeConversationId: null,
  });
}

function persistFailedOnError<T>(
  store: RunStateStore,
  runState: RunState,
  action: () => T,
): T {
  try {
    return action();
  } catch (error: unknown) {
    persistFailed(store, runState);
    throw error;
  }
}

async function main(): Promise<void> {
  const requestedInitialState =
    process.env.OH_INITIAL_STATE;

  if (
    requestedInitialState !== undefined &&
    requestedInitialState !== "PREPARING" &&
    requestedInitialState !== "IMPLEMENTING" &&
    requestedInitialState !== "REVIEWING" &&
    requestedInitialState !== "MERGING"
  ) {
    throw new Error(
      `Invalid OH_INITIAL_STATE: ${requestedInitialState}`,
    );
  }

  const client = new OpenHandsClient(
    process.env.OH_BASE_URL ?? "http://localhost:8000",
    requiredEnv("OH_SESSION_API_KEY"),
  );

  const task = loadWorkflowTask(
    requiredEnv("WORKFLOW_TASK_FILE"),
  );

  const finalState = await runWorkflow({
    client,
    task,
    store: new RunStateStore(),
    agentProfileId: requiredEnv("OH_AGENT_PROFILE_ID"),
    initialStateOverride: requestedInitialState,
  });

  if (finalState.workflowState === "FAILED") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
