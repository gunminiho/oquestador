import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { RunSummary } from "../control-plane/types";
import {
  ControlPlaneClient,
  ControlPlaneHttpError,
  ControlPlaneUnavailableError,
} from "./controlPlaneClient";
import { createOrchestratorMcpServer } from "./server";

const run: RunSummary = {
  runId: "run-a",
  taskId: "task-a",
  agentProfileId: "profile-a",
  status: "RUNNING",
  workflowState: "IMPLEMENTING",
  activeStage: "IMPLEMENTATION",
  blockReason: null,
  failureKind: null,
  pullRequestNumber: null,
  implementationCycle: 1,
  lastReviewerVerdict: null,
  lastBlockerKey: null,
  repeatedBlockerCount: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

class FakeControlPlaneClient extends ControlPlaneClient {
  lastStart:
    | {
        taskId: string;
        agentProfileId?: string;
      }
    | null = null;

  constructor() {
    super({
      baseUrl: "http://fake",
      token: "secret-token",
      fetchFn: (async () =>
        new Response("{}")) as typeof fetch,
    });
  }

  override async health() {
    return { status: "ok" };
  }

  override async listTasks() {
    return [
      {
        taskId: "task-a",
        repository: {
          owner: "gunminiho",
          name: "oquestador",
        },
        baseBranch: "main",
        workingBranch: "feat/a",
        objective: "Do work.",
        maxReviewCycles: 2,
        repeatedBlockerThreshold: null,
      },
    ];
  }

  override async startTask(input: {
    taskId: string;
    agentProfileId?: string;
  }) {
    this.lastStart = input;
    return run;
  }

  override async listRuns() {
    return [run];
  }

  override async getRun() {
    return run;
  }

  override async pauseRun() {
    return {
      ...run,
      status: "PAUSE_REQUESTED" as const,
    };
  }

  override async resumeRun() {
    return run;
  }

  override async cancelRun() {
    return {
      ...run,
      status: "CANCEL_REQUESTED" as const,
    };
  }
}

async function connect(
  controlClient: ControlPlaneClient,
) {
  const server =
    createOrchestratorMcpServer({
      client: controlClient,
    });
  const client = new Client({
    name: "test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({
    name,
    arguments: args,
  });
  const text = firstText(result);
  return {
    result,
    body: JSON.parse(text),
    text,
  };
}

test("MCP server registers the expected tools", async () => {
  const { client, server } =
    await connect(
      new FakeControlPlaneClient(),
    );

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools
        .map((tool) => tool.name)
        .sort(),
      [
        "orchestrator_cancel_run",
        "orchestrator_get_run",
        "orchestrator_health",
        "orchestrator_list_runs",
        "orchestrator_list_tasks",
        "orchestrator_pause_run",
        "orchestrator_resume_run",
        "orchestrator_start_task",
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP tools translate health, tasks, runs, and actions", async () => {
  const fake =
    new FakeControlPlaneClient();
  const { client, server } =
    await connect(fake);

  try {
    assert.equal(
      (await call(
        client,
        "orchestrator_health",
      )).body.status,
      "ok",
    );
    assert.equal(
      (await call(
        client,
        "orchestrator_list_tasks",
      )).body.tasks[0].repository,
      "gunminiho/oquestador",
    );
    assert.equal(
      (await call(
        client,
        "orchestrator_start_task",
        {
          taskId: "task-a",
          agentProfileId: "profile-a",
        },
      )).body.runId,
      "run-a",
    );
    assert.deepEqual(fake.lastStart, {
      taskId: "task-a",
      agentProfileId: "profile-a",
    });
    assert.equal(
      (await call(
        client,
        "orchestrator_list_runs",
      )).body.runs[0].workflowState,
      "IMPLEMENTING",
    );
    assert.equal(
      (await call(
        client,
        "orchestrator_get_run",
        { runId: "run-a" },
      )).body.status,
      "RUNNING",
    );
    assert.equal(
      (await call(
        client,
        "orchestrator_pause_run",
        { runId: "run-a" },
      )).body.status,
      "PAUSE_REQUESTED",
    );
    assert.equal(
      (await call(
        client,
        "orchestrator_resume_run",
        { runId: "run-a" },
      )).body.status,
      "RUNNING",
    );
    assert.equal(
      (await call(
        client,
        "orchestrator_cancel_run",
        { runId: "run-a" },
      )).body.status,
      "CANCEL_REQUESTED",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP rejects invalid payloads before calling the Control Plane", async () => {
  const fake =
    new FakeControlPlaneClient();
  const { client, server } =
    await connect(fake);

  try {
    const result =
      await client.callTool({
        name: "orchestrator_start_task",
        arguments: {
          taskId: "../outside",
        },
      });

    assert.equal(result.isError, true);
    assert.equal(fake.lastStart, null);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP preserves 404, 409, auth, unavailable, and token sanitization in errors", async () => {
  class ErrorClient extends FakeControlPlaneClient {
    constructor(
      private readonly error: Error,
    ) {
      super();
    }

    override async getRun(): Promise<RunSummary> {
      throw this.error;
    }
  }

  const cases = [
    new ControlPlaneHttpError(
      401,
      "unauthorized",
      "Missing auth.",
    ),
    new ControlPlaneHttpError(
      404,
      "not_found",
      "Run not found.",
    ),
    new ControlPlaneHttpError(
      409,
      "conflict",
      "Invalid transition.",
      { existingRunId: "run-b" },
    ),
    new ControlPlaneUnavailableError(
      "Control Plane is unreachable.",
    ),
    new ControlPlaneHttpError(
      403,
      "forbidden",
      "Bearer [redacted] rejected.",
    ),
  ];

  for (const error of cases) {
    const { client, server } =
      await connect(new ErrorClient(error));
    try {
      const response =
        await client.callTool({
          name: "orchestrator_get_run",
          arguments: { runId: "run-a" },
        });
      const text = firstText(response);
      assert.equal(response.isError, true);
      assert.equal(
        text.includes("secret-token"),
        false,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }
});

function firstText(result: unknown): string {
  const record =
    typeof result === "object" &&
    result !== null
      ? (result as {
          content?: unknown;
        })
      : {};
  const content = Array.isArray(
    record.content,
  )
    ? record.content
    : [];
  const first = content[0];

  return typeof first === "object" &&
    first !== null &&
    (first as { type?: unknown }).type ===
      "text" &&
    typeof (first as { text?: unknown })
      .text === "string"
    ? (first as { text: string }).text
    : "";
}
