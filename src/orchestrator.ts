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
      `Implementation cycle: ${displayedCycle}/${task.maxReviewCycles}`,
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

      parsePreparationResult(preparationResponse);

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

      if (
        runState.implementationCycle >
        task.maxReviewCycles
      ) {
        runState = saveState(options.store, {
          ...runState,
          workflowState: "FAILED",
          activeStage: null,
          activeConversationId: null,
        });
        break;
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
        runState = saveState(options.store, {
          ...runState,
          workflowState: "FAILED",
          activeStage: null,
          activeConversationId: null,
        });

        throw new Error(
          "Implementation finished without a Pull Request number.",
        );
      }

      task.pullRequestNumber = runState.pullRequestNumber;

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
        runState = saveState(options.store, {
          ...runState,
          workflowState: "FAILED",
          activeStage: null,
          activeConversationId: null,
        });
        throw new Error(
          "Review cannot start without a Pull Request number.",
        );
      }

      const reviewerResponse = await runAgentStage(
        options,
        runState,
        "REVIEW",
        buildReviewMessage(task, runState.pullRequestNumber),
      );
      runState = loadSavedState(options.store, task.id);

      console.log("--- Reviewer response ---\n");
      console.log(reviewerResponse);

      const verdict =
        parseReviewerVerdict(reviewerResponse);
      const nextState = nextStateAfterReview(verdict);

      runState = saveState(options.store, {
        ...runState,
        lastReviewerVerdict: verdict,
        reviewerFeedback:
          verdict === "CHANGES_REQUESTED"
            ? reviewerResponse
            : runState.reviewerFeedback,
        workflowState: nextState,
        activeStage: null,
        activeConversationId: null,
      });

      console.log(`\nVerdict: ${verdict}`);
      console.log(`Next state: ${runState.workflowState}`);

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
      runState = saveState(options.store, {
        ...runState,
        activeStage: stage,
        activeConversationId: null,
      });

      const conversation =
        await options.client.createConversation({
          workspace: options.task.workspace,
          agentProfileId: options.agentProfileId,
          message,
        });

      conversationId = conversation.id;

      runState = saveState(options.store, {
        ...runState,
        activeConversationId: conversationId,
        ...stageConversationPatch(stage, conversationId),
      });

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

    const conversation =
      await options.client.getConversation(conversationId);

    if (conversation.execution_status !== "finished") {
      await options.client.waitUntilFinished(conversationId, {
        pollIntervalMs: options.pollIntervalMs ?? 1000,
      });
    }

    return options.client.getFinalResponse(conversationId);
  } catch (error: unknown) {
    runState = saveState(options.store, {
      ...runState,
      workflowState: "FAILED",
      activeStage: null,
      activeConversationId: null,
    });

    throw error;
  }
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

async function main(): Promise<void> {
  const requestedInitialState =
    process.env.OH_INITIAL_STATE;

  if (
    requestedInitialState !== undefined &&
    requestedInitialState !== "PREPARING" &&
    requestedInitialState !== "IMPLEMENTING" &&
    requestedInitialState !== "REVIEWING"
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
