import {
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenHandsTransientError,
} from "./OpenHandsClient";
import type {
  GitHubClient,
  PullRequestDetails,
} from "./GitHubClient";
import {
  runWorkflow,
} from "./orchestrator";
import {
  createInitialRunState,
  RunStateStore,
} from "./runState";
import type {
  WorkflowTask,
} from "./task";

const SHA =
  "1111111111111111111111111111111111111111";

function task(
  id =
    "resilience-task",
): WorkflowTask {
  return {
    id,
    repository: {
      owner:
        "gunminiho",
      name:
        "oquestador",
    },
    workspace:
      "/projects/worktree",
    baseBranch:
      "main",
    workingBranch:
      "feat/test",
    objective:
      "test",
    acceptanceCriteria: [
      "works",
    ],
  };
}

function store(): RunStateStore {
  return new RunStateStore(
    mkdtempSync(
      join(
        tmpdir(),
        "resilience-",
      ),
    ),
  );
}

class GitHubFake
implements GitHubClient {
  branchPublishes = 0;
  prEnsures = 0;

  pr: PullRequestDetails = {
    number: 5,
    state: "OPEN",
    merged: false,
    baseRefName:
      "main",
    headRefName:
      "feat/test",
    headRefOid:
      SHA,
    headRepositoryOwner:
      "gunminiho",
    headRepositoryName:
      "oquestador",
    mergeCommitSha:
      null,
  };

  async ensureBranchPublished(): Promise<void> {
    this.branchPublishes += 1;
  }

  async ensurePullRequest(): Promise<{
    number: number;
  }> {
    this.prEnsures += 1;

    return {
      number: 5,
    };
  }

  async getPullRequest(): Promise<PullRequestDetails> {
    return {
      ...this.pr,
    };
  }

  async mergePullRequest(): Promise<{
    mergeCommitSha:
      string | null;
  }> {
    this.pr = {
      ...this.pr,
      state: "MERGED",
      merged: true,
      mergeCommitSha:
        SHA,
    };

    return {
      mergeCommitSha:
        SHA,
    };
  }
}

class BlockedClient {
  async createConversation(
    options: {
      conversationId?: string;
    },
  ): Promise<{
    id: string;
  }> {
    return {
      id:
        options
          .conversationId!,
    };
  }

  async getConversation(
    id: string,
  ): Promise<{
    id: string;
    execution_status:
      string;
  }> {
    return {
      id,
      execution_status:
        "finished",
    };
  }

  async waitUntilFinished(
    id: string,
  ): Promise<{
    id: string;
    execution_status:
      string;
  }> {
    return {
      id,
      execution_status:
        "finished",
    };
  }

  async getFinalResponse(): Promise<string> {
    return (
      "PREPARATION_RESULT: BLOCKED\n" +
      "PREPARATION_REASON: dirty tree"
    );
  }
}

test(
  "BLOCKED is persisted without FAILED and rerun returns to PREPARING",
  async () => {
    const stateStore =
      store();

    const first =
      await runWorkflow({
        client:
          new BlockedClient(),
        task: task(),
        store:
          stateStore,
        agentProfileId:
          "p",
        github:
          new GitHubFake(),
        pollIntervalMs:
          0,
      });

    assert.equal(
      first.workflowState,
      "BLOCKED",
    );

    assert.equal(
      first.blockReason,
      "dirty tree",
    );

    const second =
      await runWorkflow({
        client:
          new BlockedClient(),
        task: task(),
        store:
          stateStore,
        agentProfileId:
          "p",
        github:
          new GitHubFake(),
        pollIntervalMs:
          0,
      });

    assert.equal(
      second.workflowState,
      "BLOCKED",
    );

    assert.equal(
      second.preparationAttempt,
      2,
    );
  },
);

class TransientClient {
  first = true;

  async createConversation(
    options: {
      conversationId?: string;
    },
  ): Promise<{
    id: string;
  }> {
    return {
      id:
        options
          .conversationId!,
    };
  }

  async getConversation(
    id: string,
  ): Promise<{
    id: string;
    execution_status:
      string;
  }> {
    return {
      id,
      execution_status:
        "running",
    };
  }

  async waitUntilFinished(): Promise<{
    id: string;
    execution_status:
      string;
  }> {
    if (this.first) {
      this.first = false;

      throw new OpenHandsTransientError(
        "502 exhausted",
      );
    }

    return {
      id: "same",
      execution_status:
        "finished",
    };
  }

  async getFinalResponse(): Promise<string> {
    return (
      "IMPLEMENTATION_RESULT: READY_FOR_REVIEW\n" +
      "PULL_REQUEST_NUMBER: 5"
    );
  }
}

test(
  "transient stage failure preserves conversation id for resume",
  async () => {
    const stateStore =
      store();

    stateStore.save({
      ...createInitialRunState(
        "resilience-task",
        "IMPLEMENTING",
        5,
      ),
      implementationCycle:
        1,
    });

    const client =
      new TransientClient();

    await assert.rejects(
      runWorkflow({
        client,
        task: task(),
        store:
          stateStore,
        agentProfileId:
          "p",
        github:
          new GitHubFake(),
        pollIntervalMs:
          0,
      }),
      OpenHandsTransientError,
    );

    const failed =
      stateStore.load(
        "resilience-task",
      );

    assert.equal(
      failed?.failureKind,
      "TRANSIENT",
    );

    assert.equal(
      failed?.activeStage,
      "IMPLEMENTATION",
    );

    assert.equal(
      typeof failed
        ?.activeConversationId,
      "string",
    );
  },
);
