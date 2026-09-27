import { OpenHandsClient } from "./OpenHandsClient";
import { RunStateStore } from "./runState";
import { loadWorkflowTask } from "./taskLoader";
import { runTask } from "./taskRunner";

export {
  type AgentClient,
  isResourceLimitEvidence,
  type RunWorkflowOptions,
  runWorkflow,
  type TerminalErrorDetail,
} from "./workflowEngine";

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

async function main(): Promise<void> {
  const requestedInitialState =
    process.env.OH_INITIAL_STATE;

  if (
    requestedInitialState !==
      undefined &&
    requestedInitialState !==
      "PREPARING" &&
    requestedInitialState !==
      "IMPLEMENTING" &&
    requestedInitialState !==
      "REVIEWING" &&
    requestedInitialState !==
      "MERGING"
  ) {
    throw new Error(
      `Invalid OH_INITIAL_STATE: ${requestedInitialState}`,
    );
  }

  const client =
    new OpenHandsClient(
      process.env
        .OH_BASE_URL ??
        "http://localhost:8000",
      requiredEnv(
        "OH_SESSION_API_KEY",
      ),
    );

  const sourceTask =
    loadWorkflowTask(
      requiredEnv(
        "WORKFLOW_TASK_FILE",
      ),
    );

  const { runState } =
    await runTask(
      {
        task: sourceTask,
        agentProfileId:
          requiredEnv(
            "OH_AGENT_PROFILE_ID",
          ),
        initialStateOverride:
          requestedInitialState,
      },
      {
        client,
        store: new RunStateStore(),
      },
    );

  if (
    runState.workflowState ===
    "FAILED"
  ) {
    process.exitCode = 1;
  }

  if (
    runState.workflowState ===
    "BLOCKED"
  ) {
    process.exitCode = 2;
  }
}

if (
  require.main === module
) {
  main().catch(
    (
      error: unknown,
    ) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
