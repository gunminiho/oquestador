import {
  type AgentClient,
  runWorkflow,
} from "./workflowEngine";
import { GhCliGitHubClient, type GitHubClient } from "./GitHubClient";
import type { RunState, RunStateStore } from "./runState";
import type { WorkflowTask } from "./task";
import type { WorkflowState } from "./workflow";
import {
  DockerGitWorktreeManager,
  type PreparedWorkspace,
  type WorkspaceManager,
} from "./WorkspaceManager";

export interface RunTaskDependencies {
  client: AgentClient;
  store: RunStateStore;
  github?: GitHubClient;
  workspaceManager?: WorkspaceManager;
}

export interface RunTaskOptions {
  task: WorkflowTask;
  agentProfileId: string;
  initialStateOverride?: WorkflowState;
  pollIntervalMs?: number;
}

export interface RunTaskResult {
  runState: RunState;
  preparedWorkspace: PreparedWorkspace;
}

/**
 * Full single-task lifecycle: prepares an isolated workspace, runs the
 * workflow state machine to completion (or to a pause/block/failure
 * checkpoint), and cleans up the workspace only after a real DONE.
 *
 * This is the one reusable core used by both the CLI (src/orchestrator.ts
 * main()) and the HTTP Control Plane (src/control-plane/). Importing this
 * module never runs anything by itself.
 */
export async function runTask(
  options: RunTaskOptions,
  deps: RunTaskDependencies,
): Promise<RunTaskResult> {
  const workspaceManager =
    deps.workspaceManager ??
    new DockerGitWorktreeManager();

  const preparedWorkspace =
    await workspaceManager.prepare(
      options.task,
    );

  const task: WorkflowTask = {
    ...options.task,
    workspace:
      preparedWorkspace.workspace,
  };

  const github =
    deps.github ??
    new GhCliGitHubClient();

  const runState = await runWorkflow({
    client: deps.client,
    task,
    store: deps.store,
    agentProfileId:
      options.agentProfileId,
    initialStateOverride:
      options.initialStateOverride,
    pollIntervalMs:
      options.pollIntervalMs,
    github,
  });

  if (runState.workflowState === "DONE") {
    const cleaned =
      await workspaceManager.cleanup(
        preparedWorkspace,
      );

    if (!cleaned) {
      console.log(
        `Workspace preserved at ${preparedWorkspace.workspace}; cleanup safety checks did not pass.`,
      );
    }
  }

  return { runState, preparedWorkspace };
}
