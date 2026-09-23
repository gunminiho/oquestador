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
  reviewVerdicts: string[] = ["APPROVED"];
  reviewCount = 0;
  preparationResponse = "PREPARATION_RESULT: READY";
  implementationResponse = [
    "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
    "PULL_REQUEST_NUMBER: 123",
  ].join("\n");
  statuses = new Map<string, string>();
  responses = new Map<string, string>();

  async createConversation(options: {
    message: string;
    conversationId?: string;
  }): Promise<{ id: string }> {
    this.createCount += 1;
    this.messages.push(options.message);
    const id =
      options.conversationId ?? `conversation-${this.createCount}`;
    this.statuses.set(id, "finished");
    this.responses.set(id, this.responseForMessage(options.message));
    return { id };
  }

  async getConversation(
    conversationId: string,
  ): Promise<{ id: string; execution_status: string }> {
    if (!this.statuses.has(conversationId)) {
      throw new Error("OpenHands API 404 Not Found");
    }

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

  private responseForMessage(message: string): string {
    if (message.includes("Actúa exclusivamente como Reviewer")) {
      const verdict =
        this.reviewVerdicts.shift() ?? "APPROVED";
      this.reviewCount += 1;

      if (verdict === "CHANGES_REQUESTED") {
        return [
          "REVIEW_VERDICT: CHANGES_REQUESTED",
          `Please update the tests for review ${this.reviewCount}.`,
        ].join("\n");
      }

      return `REVIEW_VERDICT: ${verdict}`;
    }

    return responseForMessage.call(this, message);
  }
}

function responseForMessage(
  this: FakeClient,
  message: string,
): string {
  if (message.includes("agente de preparación Git")) {
    return this.preparationResponse;
  }

  if (message.includes("Implementador")) {
    return this.implementationResponse;
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

test("creates a new implementation conversation after reviewer requests changes", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.reviewVerdicts = ["CHANGES_REQUESTED", "APPROVED"];

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  const implementationMessages = client.messages.filter((message) =>
    message.includes("Actúa exclusivamente como Implementador."),
  );

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.implementationCycle, 2);
  assert.equal(finalState.pullRequestNumber, 123);
  assert.equal(implementationMessages.length, 2);
  assert.match(
    implementationMessages[1] ?? "",
    /Please update the tests for review 1/,
  );
  assert.equal(
    typeof store.load("workflow-task")
      ?.implementationConversationId,
    "string",
  );
});

test("continues through repeated requested changes until reviewer approves", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.reviewVerdicts = [
    "CHANGES_REQUESTED",
    "CHANGES_REQUESTED",
    "CHANGES_REQUESTED",
    "CHANGES_REQUESTED",
    "CHANGES_REQUESTED",
    "APPROVED",
  ];

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  const implementationMessages = client.messages.filter((message) =>
    message.includes("Actúa exclusivamente como Implementador."),
  );
  const reviewMessages = client.messages.filter((message) =>
    message.includes("Actúa exclusivamente como Reviewer"),
  );

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.implementationCycle, 6);
  assert.equal(implementationMessages.length, 6);
  assert.equal(reviewMessages.length, 6);
  assert.match(
    implementationMessages[1] ?? "",
    /Please update the tests for review 1/,
  );
  assert.match(
    implementationMessages[5] ?? "",
    /Please update the tests for review 5/,
  );
});

test("persists the stage conversation id before creating the remote conversation", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const createConversation =
    client.createConversation.bind(client);
  let inspectedFirstCreate = false;

  client.createConversation = async (options) => {
    if (!inspectedFirstCreate) {
      inspectedFirstCreate = true;
      const saved = store.load("workflow-task");

      assert.equal(
        saved?.activeStage,
        "PREPARATION",
      );
      assert.equal(
        saved?.activeConversationId,
        options.conversationId,
      );
      assert.equal(
        saved?.preparationConversationId,
        options.conversationId,
      );
    }

    return createConversation(options);
  };

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(inspectedFirstCreate, true);
});

test("recreates a missing remote conversation with the persisted deterministic id", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const persistedConversationId =
    "11111111-1111-5111-8111-111111111111";

  store.save({
    ...createInitialRunState("workflow-task", "IMPLEMENTING", null),
    implementationCycle: 1,
    activeStage: "IMPLEMENTATION",
    activeConversationId: persistedConversationId,
    implementationConversationId: persistedConversationId,
  });

  const finalState = await runWorkflow({
    client,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.createCount, 2);
  assert.equal(
    store.load("workflow-task")?.implementationConversationId,
    persistedConversationId,
  );
  assert.equal(finalState.pullRequestNumber, 123);
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

test("persists FAILED when preparation final response is invalid", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.preparationResponse = "PREPARATION_RESULT: NOT_READY";

  await assert.rejects(
    runWorkflow({
      client,
      task: task(),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /Expected exactly one PREPARATION_RESULT/,
  );

  const saved = store.load("workflow-task");
  assert.equal(saved?.workflowState, "FAILED");
  assert.equal(saved?.activeStage, null);
  assert.equal(saved?.activeConversationId, null);
});

test("persists FAILED when implementation final response is invalid", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.implementationResponse =
    "IMPLEMENTATION_RESULT: NOT_READY";

  await assert.rejects(
    runWorkflow({
      client,
      task: task(),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /Expected exactly one IMPLEMENTATION_RESULT/,
  );

  const saved = store.load("workflow-task");
  assert.equal(saved?.workflowState, "FAILED");
  assert.equal(saved?.activeStage, null);
  assert.equal(saved?.activeConversationId, null);
});

test("persists FAILED when reviewer final response is invalid", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  client.reviewVerdicts = ["INVALID"];

  await assert.rejects(
    runWorkflow({
      client,
      task: task(),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /Expected exactly one REVIEW_VERDICT/,
  );

  const saved = store.load("workflow-task");
  assert.equal(saved?.workflowState, "FAILED");
  assert.equal(saved?.activeStage, null);
  assert.equal(saved?.activeConversationId, null);
});
