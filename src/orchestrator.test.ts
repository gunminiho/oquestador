import { execFile } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import type {
  GitHubClient,
  MergePullRequestResult,
  PullRequestDetails,
} from "./GitHubClient";
import { runWorkflow as runRealWorkflow } from "./orchestrator";
import {
  createInitialRunState,
  RunStateStore,
} from "./runState";
import type { WorkflowTask } from "./task";

const SHA_ONE = "1111111111111111111111111111111111111111";
const SHA_TWO = "2222222222222222222222222222222222222222";
const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const execFileAsync =
  promisify(execFile);

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
  implementationResponses: string[] = [];
  statuses = new Map<string, string>();
  responses = new Map<string, string>();

  async createConversation(options: {
    message: string;
    conversationId?: string;
  }): Promise<{
    id: string;
    execution_status: string;
  }> {
    this.createCount += 1;
    this.messages.push(options.message);
    const id =
      options.conversationId ?? `conversation-${this.createCount}`;
    this.statuses.set(id, "finished");
    this.responses.set(id, this.responseForMessage(options.message));
    return {
      id,
      execution_status: "finished",
    };
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

class FakeGitHubClient implements GitHubClient {
  getCount = 0;
  ensureBranchPublishedCount = 0;
  ensurePullRequestCount = 0;
  mergeCount = 0;
  mergeExpectedHeadShas: string[] = [];
  pullRequest: PullRequestDetails = {
    number: 123,
    state: "OPEN",
    merged: false,
    baseRefName: "main",
    headRefName: "agent/crash-safe-workflow-resume",
    headRefOid: SHA_ONE,
    headRepositoryOwner: "gunminiho",
    headRepositoryName: "oquestador",
    mergeCommitSha: null,
  };
  afterGet: Array<(client: FakeGitHubClient) => void> = [];

  async getPullRequest(): Promise<PullRequestDetails> {
    this.getCount += 1;
    const pullRequest = { ...this.pullRequest };
    const callback = this.afterGet.shift();
    if (callback !== undefined) {
      callback(this);
    }
    return pullRequest;
  }

  async ensureBranchPublished(): Promise<void> {
    this.ensureBranchPublishedCount += 1;
  }

  async ensurePullRequest(): Promise<{ number: number }> {
    this.ensurePullRequestCount += 1;

    return {
      number:
        this.pullRequest.number,
    };
  }

  async mergePullRequest(options: {
    expectedHeadSha: string;
  }): Promise<MergePullRequestResult> {
    this.mergeCount += 1;
    this.mergeExpectedHeadShas.push(options.expectedHeadSha);
    if (this.pullRequest.headRefOid !== options.expectedHeadSha) {
      throw new Error("Head commit changed");
    }
    this.pullRequest = {
      ...this.pullRequest,
      state: "MERGED",
      merged: true,
      mergeCommitSha: MERGE_SHA,
    };
    return { mergeCommitSha: MERGE_SHA };
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
    const response =
      this.implementationResponses.shift();

    if (response !== undefined) {
      return response;
    }

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

async function git(
  workspace: string,
  args: string[],
): Promise<string> {
  const { stdout } =
    await execFileAsync(
      "git",
      [
        "-C",
        workspace,
        ...args,
      ],
      {
        encoding: "utf8",
      },
    );

  return stdout;
}

async function createRepositoryAtBase(): Promise<{
  workspace: string;
  baseSha: string;
}> {
  const root =
    mkdtempSync(
      join(
        tmpdir(),
        "orchestrator-git-test-",
      ),
    );
  const remote =
    join(root, "remote.git");
  const workspace =
    join(root, "workspace");

  await execFileAsync(
    "git",
    [
      "init",
      "--bare",
      remote,
    ],
  );
  await execFileAsync(
    "git",
    [
      "clone",
      remote,
      workspace,
    ],
  );
  await git(
    workspace,
    [
      "checkout",
      "-b",
      "main",
    ],
  );
  await git(
    workspace,
    [
      "config",
      "user.email",
      "test@example.com",
    ],
  );
  await git(
    workspace,
    [
      "config",
      "user.name",
      "Test User",
    ],
  );
  writeFileSync(
    join(workspace, "README.md"),
    "ready\n",
    "utf8",
  );
  await git(
    workspace,
    [
      "add",
      "README.md",
    ],
  );
  await git(
    workspace,
    [
      "commit",
      "-m",
      "Initial commit",
    ],
  );
  await git(
    workspace,
    [
      "push",
      "-u",
      "origin",
      "main",
    ],
  );
  const baseSha =
    (
      await git(
        workspace,
        [
          "rev-parse",
          "HEAD",
        ],
      )
    ).trim();

  return {
    workspace,
    baseSha,
  };
}

async function runWorkflow(
  options: Parameters<typeof runRealWorkflow>[0] & {
    github?: GitHubClient;
  },
) {
  return runRealWorkflow({
    ...options,
    github: options.github ?? new FakeGitHubClient(),
  });
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

test("NO_CHANGES_REQUIRED skips branch publication and Pull Request creation", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  const repo =
    await createRepositoryAtBase();
  client.implementationResponse =
    "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED";

  const finalState = await runWorkflow({
    client,
    github,
    task: task({
      workspace:
        repo.workspace,
    }),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.pullRequestNumber, null);
  assert.equal(finalState.noChangesBaseSha, repo.baseSha);
  assert.equal(finalState.approvedHeadSha, null);
  assert.equal(finalState.mergeCommitSha, null);
  assert.equal(github.ensureBranchPublishedCount, 0);
  assert.equal(github.ensurePullRequestCount, 0);
  assert.equal(github.mergeCount, 0);
});

test("NO_CHANGES_REQUIRED reviewer approval ends DONE without PR", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  const repo =
    await createRepositoryAtBase();
  client.implementationResponse =
    "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED";

  const finalState = await runWorkflow({
    client,
    github,
    task: task({
      workspace:
        repo.workspace,
    }),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  const reviewMessage =
    client.messages.find((message) =>
      message.includes(
        "NO EXISTE Pull Request",
      ),
    );

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.pullRequestNumber, null);
  assert.equal(finalState.mergeCommitSha, null);
  assert.match(reviewMessage ?? "", new RegExp(repo.baseSha));
});

test("NO_CHANGES_REQUIRED reviewer changes returns to implementation", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  const repo =
    await createRepositoryAtBase();
  client.implementationResponses = [
    "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED",
    [
      "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
      "PULL_REQUEST_NUMBER: 123",
    ].join("\n"),
  ];
  client.reviewVerdicts = [
    "CHANGES_REQUESTED",
    "APPROVED",
  ];

  const finalState =
    await runWorkflow({
      client,
      github,
      task: task({
        workspace:
          repo.workspace,
      }),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.implementationCycle, 2);
  assert.equal(finalState.noChangesBaseSha, null);
  assert.equal(finalState.pullRequestNumber, 123);
  assert.equal(github.ensureBranchPublishedCount, 1);
  assert.equal(github.ensurePullRequestCount, 1);
  assert.equal(github.mergeCount, 1);
});

test("NO_CHANGES_REQUIRED fails safely with local changes", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  const repo =
    await createRepositoryAtBase();
  client.implementationResponse =
    "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED";
  writeFileSync(
    join(repo.workspace, "local.txt"),
    "dirty\n",
    "utf8",
  );

  await assert.rejects(
    runWorkflow({
      client,
      github,
      task: task({
        workspace:
          repo.workspace,
      }),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /local changes/,
  );

  assert.equal(store.load("workflow-task")?.workflowState, "FAILED");
  assert.equal(github.ensureBranchPublishedCount, 0);
  assert.equal(github.ensurePullRequestCount, 0);
});

test("NO_CHANGES_REQUIRED fails safely with commits ahead of base", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  const repo =
    await createRepositoryAtBase();
  client.implementationResponse =
    "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED";
  writeFileSync(
    join(repo.workspace, "ahead.txt"),
    "ahead\n",
    "utf8",
  );
  await git(
    repo.workspace,
    [
      "add",
      "ahead.txt",
    ],
  );
  await git(
    repo.workspace,
    [
      "commit",
      "-m",
      "Ahead commit",
    ],
  );

  await assert.rejects(
    runWorkflow({
      client,
      github,
      task: task({
        workspace:
          repo.workspace,
      }),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /commits ahead/,
  );

  assert.equal(store.load("workflow-task")?.workflowState, "FAILED");
  assert.equal(github.ensureBranchPublishedCount, 0);
  assert.equal(github.ensurePullRequestCount, 0);
});

test("NO_CHANGES_REQUIRED fails safely when HEAD differs from base", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  const repo =
    await createRepositoryAtBase();
  client.implementationResponse =
    "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED";
  writeFileSync(
    join(repo.workspace, "base-moved.txt"),
    "base moved\n",
    "utf8",
  );
  await git(
    repo.workspace,
    [
      "add",
      "base-moved.txt",
    ],
  );
  await git(
    repo.workspace,
    [
      "commit",
      "-m",
      "Move base",
    ],
  );
  await git(
    repo.workspace,
    [
      "push",
      "origin",
      "main",
    ],
  );
  await git(
    repo.workspace,
    [
      "checkout",
      "--detach",
      repo.baseSha,
    ],
  );

  await assert.rejects(
    runWorkflow({
      client,
      github,
      task: task({
        workspace:
          repo.workspace,
      }),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /is not origin\/main/,
  );

  assert.equal(store.load("workflow-task")?.workflowState, "FAILED");
  assert.equal(github.ensureBranchPublishedCount, 0);
  assert.equal(github.ensurePullRequestCount, 0);
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

test("APPROVED moves through MERGING and merges exactly the reviewed head SHA", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();

  const finalState = await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.approvedHeadSha, SHA_ONE);
  assert.equal(finalState.mergeCommitSha, MERGE_SHA);
  assert.deepEqual(github.mergeExpectedHeadShas, [SHA_ONE]);
});

test("CHANGES_REQUESTED returns to IMPLEMENTING without attempting merge", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  client.reviewVerdicts = ["CHANGES_REQUESTED", "APPROVED"];

  const finalState = await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(finalState.implementationCycle, 2);
  assert.equal(github.mergeCount, 1);
  assert.deepEqual(github.mergeExpectedHeadShas, [SHA_ONE]);
});

test("CHANGES_REQUESTED does not attempt merge before implementation resumes", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  client.reviewVerdicts = ["CHANGES_REQUESTED"];
  client.implementationResponse = "IMPLEMENTATION_RESULT: NOT_READY";
  store.save({
    ...createInitialRunState("workflow-task", "REVIEWING", 123),
    implementationCycle: 1,
  });

  await assert.rejects(
    runWorkflow({
      client,
      github,
      task: task(),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /Expected exactly one IMPLEMENTATION_RESULT/,
  );

  assert.equal(github.mergeCount, 0);
});

test("does not merge when HEAD changes after APPROVED and creates a new review", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  github.afterGet = [
    () => {},
    (fake) => {
      fake.pullRequest = {
        ...fake.pullRequest,
        headRefOid: SHA_TWO,
      };
    },
  ];

  const finalState = await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  const reviewMessages = client.messages.filter((message) =>
    message.includes("Actúa exclusivamente como Reviewer"),
  );

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.reviewCount, 2);
  assert.equal(github.mergeCount, 1);
  assert.deepEqual(github.mergeExpectedHeadShas, [SHA_TWO]);
  assert.match(reviewMessages[0] ?? "", new RegExp(SHA_ONE));
  assert.match(reviewMessages[1] ?? "", new RegExp(SHA_TWO));
});

test("review conversation ids differ for the same cycle when HEAD changes", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  github.afterGet = [
    () => {},
    (fake) => {
      fake.pullRequest = {
        ...fake.pullRequest,
        headRefOid: SHA_TWO,
      };
    },
  ];

  await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  const reviewIds = [...client.statuses.keys()].filter(
    (id) => client.responses.get(id)?.includes("REVIEW_VERDICT"),
  );

  assert.equal(reviewIds.length, 2);
  assert.notEqual(reviewIds[0], reviewIds[1]);
});

test("resumes from MERGING with an open PR and correct HEAD", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  store.save({
    ...createInitialRunState("workflow-task", "MERGING", 123),
    implementationCycle: 1,
    reviewAttempt: 1,
    reviewHeadSha: SHA_ONE,
    approvedHeadSha: SHA_ONE,
    lastReviewerVerdict: "APPROVED",
  });

  const finalState = await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.createCount, 0);
  assert.deepEqual(github.mergeExpectedHeadShas, [SHA_ONE]);
});

test("recovers from MERGING when GitHub already reports the PR merged", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  github.pullRequest = {
    ...github.pullRequest,
    state: "MERGED",
    merged: true,
    mergeCommitSha: MERGE_SHA,
  };
  store.save({
    ...createInitialRunState("workflow-task", "MERGING", 123),
    implementationCycle: 1,
    reviewAttempt: 1,
    reviewHeadSha: SHA_ONE,
    approvedHeadSha: SHA_ONE,
    lastReviewerVerdict: "APPROVED",
  });

  const finalState = await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(github.mergeCount, 0);
});

test("fails recovery when an already merged PR has a different HEAD", async () => {
  const store = temporaryStore();
  const client = new FakeClient();
  const github = new FakeGitHubClient();
  github.pullRequest = {
    ...github.pullRequest,
    state: "MERGED",
    merged: true,
    headRefOid: SHA_TWO,
  };
  store.save({
    ...createInitialRunState("workflow-task", "MERGING", 123),
    implementationCycle: 1,
    reviewAttempt: 1,
    reviewHeadSha: SHA_ONE,
    approvedHeadSha: SHA_ONE,
    lastReviewerVerdict: "APPROVED",
  });

  await assert.rejects(
    runWorkflow({
      client,
      github,
      task: task(),
      store,
      agentProfileId: "profile",
      pollIntervalMs: 0,
    }),
    /expected approved head/,
  );

  assert.equal(store.load("workflow-task")?.workflowState, "FAILED");
  assert.equal(github.mergeCount, 0);
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
  const github = new FakeGitHubClient();
  github.pullRequest = {
    ...github.pullRequest,
    number: 88,
  };
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
    github,
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
    reviewAttempt: 1,
    reviewHeadSha: SHA_ONE,
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
  const github = new FakeGitHubClient();
  store.save({
    ...createInitialRunState("workflow-task", "DONE", 101),
    implementationCycle: 1,
    lastReviewerVerdict: "APPROVED",
  });

  const finalState = await runWorkflow({
    client,
    github,
    task: task(),
    store,
    agentProfileId: "profile",
    pollIntervalMs: 0,
  });

  assert.equal(finalState.workflowState, "DONE");
  assert.equal(client.createCount, 0);
  assert.equal(client.waitCount, 0);
  assert.equal(github.getCount, 0);
  assert.equal(github.mergeCount, 0);
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
    reviewAttempt: 1,
    reviewHeadSha: SHA_ONE,
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
