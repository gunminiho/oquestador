import { GhCliGitHubClient } from "../GitHubClient";
import { OpenHandsClient } from "../OpenHandsClient";
import { RunStateStore } from "../runState";
import { DockerGitWorktreeManager } from "../WorkspaceManager";

import { RunManager } from "./runManager";
import { createControlPlaneServer } from "./server";
import { ControlPlaneStore } from "./store";

function requiredEnv(
  name: string,
): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`,
    );
  }

  return value;
}

async function main(): Promise<void> {
  const controlToken = requiredEnv(
    "ORCHESTRATOR_CONTROL_TOKEN",
  );

  const client = new OpenHandsClient(
    process.env.OH_BASE_URL ??
      "http://localhost:8000",
    requiredEnv("OH_SESSION_API_KEY"),
  );

  const runManager = new RunManager({
    taskRoot:
      process.env
        .ORCHESTRATOR_TASK_ROOT ??
      "tasks",
    runStateStore: new RunStateStore(
      process.env
        .ORCHESTRATOR_RUN_STATE_DIR ??
        ".orchestrator/runs",
    ),
    controlPlaneStore:
      new ControlPlaneStore(
        process.env
          .ORCHESTRATOR_CONTROL_STATE_DIR ??
          ".orchestrator/control-plane/runs",
      ),
    client,
    defaultAgentProfileId:
      process.env.OH_AGENT_PROFILE_ID,
    github: new GhCliGitHubClient(),
    workspaceManager:
      new DockerGitWorktreeManager(),
    worktreeRoot:
      process.env.OH_WORKTREE_ROOT,
  });

  const server =
    createControlPlaneServer({
      runManager,
      controlToken,
      host:
        process.env
          .ORCHESTRATOR_CONTROL_HOST,
      port: process.env
        .ORCHESTRATOR_CONTROL_PORT
        ? Number(
            process.env
              .ORCHESTRATOR_CONTROL_PORT,
          )
        : undefined,
    });

  const { host, port } =
    await server.listen();

  console.log(
    `Control Plane listening on http://${host}:${port}`,
  );

  let shuttingDown = false;

  const shutdown = (
    signal: string,
  ): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(
      `Received ${signal}; shutting down the Control Plane. New runs are refused; persisted state and any already-running external conversations are left as-is.`,
    );

    server
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };

  process.on("SIGINT", () =>
    shutdown("SIGINT"),
  );
  process.on("SIGTERM", () =>
    shutdown("SIGTERM"),
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
