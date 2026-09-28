import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ControlPlaneClient } from "./controlPlaneClient";
import { createOrchestratorMcpServer } from "./server";

test("MCP smoke registers tools and translates a fake health response", async () => {
  class SmokeClient extends ControlPlaneClient {
    constructor() {
      super({
        baseUrl: "http://fake",
        token: "placeholder",
        fetchFn: (async () =>
          new Response("{}")) as typeof fetch,
      });
    }

    override async health() {
      return { status: "ok" };
    }
  }

  const server =
    createOrchestratorMcpServer({
      client: new SmokeClient(),
    });
  const client = new Client({
    name: "smoke",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some(
        (tool) =>
          tool.name ===
          "orchestrator_health",
      ),
    );

    const health =
      await client.callTool({
        name: "orchestrator_health",
        arguments: {},
      });
    assert.match(
      firstText(health),
      /"status": "ok"/,
    );
  } finally {
    await client.close();
    await server.close();
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
