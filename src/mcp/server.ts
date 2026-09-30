import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  RunSummary,
  TaskSummary,
} from "../control-plane/types";
import {
  ControlPlaneClient,
  ControlPlaneHttpError,
  ControlPlaneUnavailableError,
} from "./controlPlaneClient";

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const emptyInputSchema = z
  .object({})
  .strict();
const taskIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/);
const runIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(ID_PATTERN);
const agentProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(ID_PATTERN);

export interface OrchestratorMcpServerOptions {
  client: ControlPlaneClient;
}

export function createOrchestratorMcpServer(
  options: OrchestratorMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: "oquestador-control-plane",
    version: "1.0.0",
  });

  server.registerTool(
    "orchestrator_health",
    {
      title: "Orchestrator health",
      description:
        "Checks whether the Control Plane is reachable.",
      inputSchema: emptyInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withToolErrors(async () =>
      toolResult(
        await options.client.health(),
      ),
    ),
  );

  server.registerTool(
    "orchestrator_list_tasks",
    {
      title: "List orchestrator tasks",
      description:
        "Lists valid allowlisted tasks exposed by the Control Plane.",
      inputSchema: emptyInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withToolErrors(async () =>
      toolResult({
        tasks: compactTasks(
          await options.client.listTasks(),
        ),
      }),
    ),
  );

  server.registerTool(
    "orchestrator_start_task",
    {
      title: "Start orchestrator task",
      description:
        "Starts an allowlisted task by taskId through the Control Plane.",
      inputSchema: z
        .object({
          taskId: taskIdSchema.describe(
            "Allowlisted task id, without a path.",
          ),
          agentProfileId:
            agentProfileIdSchema
              .optional()
              .describe(
                "Optional Agent Canvas profile id configured in the Control Plane.",
              ),
          stageAgentProfileIds: z.object({ PREPARATION: agentProfileIdSchema.optional(), IMPLEMENTATION: agentProfileIdSchema.optional(), REVIEW: agentProfileIdSchema.optional() }).strict().optional().describe("Optional explicit profile ids per workflow stage."),
        })
        .strict(),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    withToolErrors(async (args) =>
      toolResult(
        compactRun(
          await options.client.startTask({
            taskId: args.taskId,
            agentProfileId:
              args.agentProfileId,
            ...(args.stageAgentProfileIds === undefined ? {} : { stageAgentProfileIds: args.stageAgentProfileIds }),
          }),
        ),
      ),
    ),
  );

  registerRunReader(
    server,
    options.client,
  );
  registerRunAction(
    server,
    options.client,
    "orchestrator_pause_run",
    "Requests a cooperative pause for a run.",
    (client, runId) =>
      client.pauseRun(runId),
  );
  registerRunAction(
    server,
    options.client,
    "orchestrator_resume_run",
    "Resumes a paused, blocked, resource-limited, or interrupted run.",
    (client, runId) =>
      client.resumeRun(runId),
  );
  registerRunAction(
    server,
    options.client,
    "orchestrator_cancel_run",
    "Requests cooperative cancellation for a run.",
    (client, runId) =>
      client.cancelRun(runId),
  );

  return server;
}

function registerRunReader(
  server: McpServer,
  client: ControlPlaneClient,
): void {
  server.registerTool(
    "orchestrator_list_runs",
    {
      title: "List orchestrator runs",
      description:
        "Lists known Control Plane runs and public status.",
      inputSchema: emptyInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withToolErrors(async () =>
      toolResult({
        runs: compactRuns(
          await client.listRuns(),
        ),
      }),
    ),
  );

  server.registerTool(
    "orchestrator_get_run",
    {
      title: "Get orchestrator run",
      description:
        "Gets one Control Plane run by runId.",
      inputSchema: z
        .object({
          runId: runIdSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withToolErrors(async (args) =>
      toolResult(
        compactRun(
          await client.getRun(args.runId),
        ),
      ),
    ),
  );
}

function registerRunAction(
  server: McpServer,
  client: ControlPlaneClient,
  name: string,
  description: string,
  action: (
    client: ControlPlaneClient,
    runId: string,
  ) => Promise<RunSummary>,
): void {
  server.registerTool(
    name,
    {
      title: name
        .replace(/^orchestrator_/, "")
        .replace(/_/g, " "),
      description,
      inputSchema: z
        .object({
          runId: runIdSchema,
        })
        .strict(),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    withToolErrors(async (args) =>
      toolResult(
        compactRun(
          await action(
            client,
            args.runId,
          ),
        ),
      ),
    ),
  );
}

export function formatMcpError(
  error: unknown,
): string {
  if (
    error instanceof ControlPlaneHttpError
  ) {
    const suffix =
      error.details?.existingRunId &&
      typeof error.details
        .existingRunId === "string"
        ? ` existingRunId=${error.details.existingRunId}`
        : "";
    return `Control Plane ${error.status} ${error.code}: ${error.message}${suffix}`;
  }

  if (
    error instanceof
    ControlPlaneUnavailableError
  ) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected MCP tool error.";
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          value,
          null,
          2,
        ),
      },
    ],
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: formatMcpError(error),
      },
    ],
  };
}

function withToolErrors<Args>(
  fn: (
    args: Args,
  ) => ReturnType<typeof toolResult> | Promise<
    ReturnType<typeof toolResult>
  >,
) {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (error: unknown) {
      return toolError(error);
    }
  };
}

function compactTasks(
  tasks: TaskSummary[],
) {
  return tasks.map(compactTask);
}

function compactTask(task: TaskSummary) {
  return {
    taskId: task.taskId,
    repository: `${task.repository.owner}/${task.repository.name}`,
    baseBranch: task.baseBranch,
    workingBranch: task.workingBranch,
    objective: task.objective,
    maxReviewCycles:
      task.maxReviewCycles,
    repeatedBlockerThreshold:
      task.repeatedBlockerThreshold,
  };
}

function compactRuns(runs: RunSummary[]) {
  return runs.map(compactRun);
}

function compactRun(run: RunSummary) {
  return {
    runId: run.runId,
    taskId: run.taskId,
    status: run.status,
    workflowState:
      run.workflowState,
    activeStage: run.activeStage,
    blockReason: run.blockReason,
    failureKind: run.failureKind,
    pullRequestNumber:
      run.pullRequestNumber,
    implementationCycle:
      run.implementationCycle,
    lastReviewerVerdict:
      run.lastReviewerVerdict,
    lastBlockerKey:
      run.lastBlockerKey,
    repeatedBlockerCount:
      run.repeatedBlockerCount,
  };
}
