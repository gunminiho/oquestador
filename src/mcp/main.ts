import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ControlPlaneClient } from "./controlPlaneClient";
import {
  createOrchestratorMcpServer,
  formatMcpError,
} from "./server";

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

export async function main(): Promise<void> {
  const client =
    new ControlPlaneClient({
      baseUrl: requiredEnv(
        "ORCHESTRATOR_CONTROL_URL",
      ),
      token: requiredEnv(
        "ORCHESTRATOR_CONTROL_TOKEN",
      ),
      timeoutMs: process.env
        .ORCHESTRATOR_MCP_TIMEOUT_MS
        ? Number(
            process.env
              .ORCHESTRATOR_MCP_TIMEOUT_MS,
          )
        : undefined,
    });

  const server =
    createOrchestratorMcpServer({
      client,
    });

  await server.connect(
    new StdioServerTransport(),
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(formatMcpError(error));
    process.exitCode = 1;
  });
}
