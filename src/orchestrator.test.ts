import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runWorkflow } from "./orchestrator";
import {
  createInitialRunState,
  RunStateStore,
} from "./runState";
import type { WorkflowTask } from "./task";

class FakeClient {
  createCount = 0;
  waitCount = 0;
  finalCount = 0;
  messages: string[] = [];
  statuses = new Map<string, string>();
  responses = new Map<string, string>();

  async createConversation(options: {
    message: string;
  }): Promise<{ id: string }> {
    this.createCount += 1;
    this.messages.push(options.message);
    const id = `conversation-${this.createCount}`;
    this.statuses.set(id, "finished");
    this.responses.set(id, responseForMessage(options.message));
    return { id };
  }

  async getConversation(
    conversationId: string,
  ): Promise<{ id: string; execution_status: string }> {
    return {
      id: conversationId,
      execution_status:
        this.statuses.get(conversationId) ?? "finished",
    };
  }

  async waitUntilFinished(
    conversationId: string,
  ): Promise<{ id: string; execution_status: string }> {
    this.waitCount += 1;
    this.statuses.set(conversationId, "finished");
    return {
      id: conversationId,
      execution_status: "finished",
    };
  }

  async getFinalResponse(
    conversationId: string,
  ): Promise<string> {
    this.finalCount += 1;
    const response = this.responses.get(conversationId);

    if (response === undefined) {
      throw new Error(`Missing response for ${conversationId}`);
    }

    return response;
  }
}

function responseForMessage(message: string): string {
  if (message.includes("agente de preparación Git")) {
    return "PREPARATION_RESULT: READY";
  }

  if (message.includes("Actúa exclusivamente como Reviewer")) {
    return "REVIEW_VERDICT: APPROVED";
  }

  if (message.includes("Implementador")) {
    return [
      "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
      "PULL_REQUEST_NUMBER: 123",
    ].join("\n");
  }

  throw new Error("Unknown message");
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: "workflow-task",
    repository: {
      owner: "gunminiho",
      name: "oquestador",
    },
    workspace: "/projects/oquestador",
    baseBranch: "main",
    workingBranch: "agent/crash-safe-workflow-resume",
    objective: "Make workflow crash safe",
    acceptanceCriteria: ["Persist state"],
    maxReviewCycles: 3,
    ...overrides,
  };
}

function temporaryStore(): RunStateStore {
  return new RunStateStore(
    mkdtempSync(join(tmpdir(), "orchestrator-test-")),
  );
}

test("resumes from PREPARING and completes workflow", async () => {
  const store = temporaryStore();
  const client = new FakeClient();

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.implementationCycle, 1);
  assert.equal(finalState.pullRequestNumber, 123);
  assert.equal(client.createCount, 3);
});

test("resumes from IMPLEMENTING preserving cycle, PR, and reviewer feedback", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  store.save({
    ...createInitialRunState("workflow-task", "IMPLEMENTING", 77),
    implementationCycle: 2,
    reviewerFeedback: "please fix the tests",
  });

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.implementationCycle, 3);
  assert.equal(finalState.pullRequestNumber, 123);
  assert.match(client.messages[0] ?? "", /please fix the tests/);
});

test("resumes from REVIEWING preserving Pull Request number", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  store.save({
    ...createInitialRunState("workflow-task", "REVIEWING", 55),
    implementationCycle: 1,
  });

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.pullRequestNumber, 55);
  assert.equal(client.createCount, 1);
  assert.match(client.messages[0] ?? "", /#55/);
});

test("reuses an active persisted conversation instead of creating a second one", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.statuses.set("existing-impl", "running");
  client.responses.set(
    "existing-impl",
    [
      "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
      "PULL_REQUEST_NUMBER: 88",
    ].join("\n"),
  );
  store.save({
    ...createInitialRunState("workflow-task", "IMPLEMENTING", null),
    implementationCycle: 1,
    activeStage: "IMPLEMENTATION",
    activeConversationId: "existing-impl",
    implementationConversationId: "existing-impl",
  });

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.waitCount, 1);
  assert.equal(client.createCount, 1);
  assert.equal(finalState.pullRequestNumber, 88);
});

test("processes an already finished persisted conversation without launching another", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.statuses.set("finished-review", "finished");
  client.responses.set(
    "finished-review",
    "REVIEW_VERDICT: APPROVED",
  );
  store.save({
    ...createInitialRunState("workflow-task", "REVIEWING", 90),
    implementationCycle: 2,
    activeStage: "REVIEW",
    activeConversationId: "finished-review",
    reviewConversationId: "finished-review",
  });

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.createCount, 0);
  assert.equal(client.waitCount, 0);
  assert.equal(client.finalCount, 1);
});

test("DONE RunState is idempotent", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  store.save({
    ...createInitialRunState("workflow-task", "DONE", 101),
    implementationCycle: 1,
    lastReviewerVerdict: "APPROVED",
  });

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.createCount, 0);
  assert.equal(client.waitCount, 0);
});

test("persists FAILED when a resumed conversation fails", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.statuses.set("bad-review", "running");
  client.waitUntilFinished = async () => {
    throw new Error("terminal status error");
  };
  store.save({
    ...createInitialRunState("workflow-task", "REVIEWING", 102),
    implementationCycle: 1,
    activeStage: "REVIEW",
    activeConversationId: "bad-review",
    reviewConversationId: "bad-review",
  });

  await assert.rejects(
    runWorkflow({
      client,
      task: task(),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /terminal status error/,
  );

  assert.equal(
    store.load("workflow-task")?.workflowState,
    "FAILED",
  );
});
