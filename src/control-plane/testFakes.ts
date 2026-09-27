import type {
  GitHubClient,
  MergePullRequestResult,
  PullRequestDetails,
} from "../GitHubClient";
import type { WorkflowTask } from "../task";
import type { AgentClient } from "../workflowEngine";
import type {
  PreparedWorkspace,
  WorkspaceManager,
} from "../WorkspaceManager";

/**
 * A controllable AgentClient fake for Control Plane tests. Every created
 * conversation stays "running" (and `waitUntilFinished` stays pending)
 * until the test explicitly calls `finishNext`/`finish`, so pause/cancel
 * checkpoints can be exercised deterministically instead of racing a real
 * timer.
 */
export class ControllableAgentClient
implements AgentClient {
  createCount = 0;
  readonly createdConversationIds: string[] =
    [];
  defaultResponse =
    "PREPARATION_RESULT: READY";

  private readonly finishedResponses =
    new Map<string, string>();
  private readonly waiters = new Map<
    string,
    Array<() => void>
  >();

  async createConversation(options: {
    conversationId?: string;
  }): Promise<{
    id: string;
    execution_status: string;
  }> {
    this.createCount += 1;
    const id = options.conversationId!;
    this.createdConversationIds.push(id);

    return {
      id,
      execution_status: "running",
    };
  }

  async getConversation(
    id: string,
  ): Promise<{
    id: string;
    execution_status: string;
  }> {
    return {
      id,
      execution_status:
        this.finishedResponses.has(id)
          ? "finished"
          : "running",
    };
  }

  async waitUntilFinished(
    id: string,
  ): Promise<{
    id: string;
    execution_status: string;
  }> {
    if (
      !this.finishedResponses.has(id)
    ) {
      await new Promise<void>(
        (resolve) => {
          const pending =
            this.waiters.get(id) ?? [];
          pending.push(resolve);
          this.waiters.set(
            id,
            pending,
          );
        },
      );
    }

    return {
      id,
      execution_status: "finished",
    };
  }

  async getFinalResponse(
    id: string,
  ): Promise<string> {
    return (
      this.finishedResponses.get(id) ??
      this.defaultResponse
    );
  }

  /** Finishes a specific conversation id with the given final response. */
  finish(
    id: string,
    response = this
      .defaultResponse,
  ): void {
    this.finishedResponses.set(
      id,
      response,
    );

    const pending =
      this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    pending.forEach((resolve) =>
      resolve(),
    );
  }

  /** Finishes whichever conversation is currently pending a wait. */
  finishNext(
    response = this
      .defaultResponse,
  ): void {
    const [id] = this.waiters.keys();

    if (id === undefined) {
      throw new Error(
        "ControllableAgentClient.finishNext: no pending conversation.",
      );
    }

    this.finish(id, response);
  }

  hasPending(): boolean {
    return this.waiters.size > 0;
  }
}

/** No-op workspace manager: the task's own workspace path is used as-is. */
export class FakeWorkspaceManager
implements WorkspaceManager {
  cleanupCalls = 0;

  async prepare(
    task: WorkflowTask,
  ): Promise<PreparedWorkspace> {
    return {
      workspace: task.workspace,
      sourceWorkspace: task.workspace,
      workingBranch:
        task.workingBranch,
    };
  }

  async cleanup(): Promise<boolean> {
    this.cleanupCalls += 1;
    return true;
  }
}

const FAKE_HEAD_SHA =
  "cafecafecafecafecafecafecafecafecafecafe";
const FAKE_MERGE_SHA =
  "d00d000000000000000000000000000000000d0d".slice(
    0,
    40,
  );

/** Minimal deterministic GitHubClient fake: approves and merges instantly. */
export class FakeGitHubClient
implements GitHubClient {
  mergeCalls = 0;
  pullRequestNumber = 1;
  repositoryOwner = "gunminiho";
  repositoryName =
    "oquestador-fixture";
  headBranch = "agent/fake";
  private merged = false;

  async getPullRequest(): Promise<PullRequestDetails> {
    return {
      number: this.pullRequestNumber,
      state: this.merged
        ? "MERGED"
        : "OPEN",
      merged: this.merged,
      baseRefName: "main",
      headRefName: this.headBranch,
      headRefOid: FAKE_HEAD_SHA,
      headRepositoryOwner:
        this.repositoryOwner,
      headRepositoryName:
        this.repositoryName,
      mergeCommitSha: this.merged
        ? FAKE_MERGE_SHA
        : null,
    };
  }

  async ensureBranchPublished(): Promise<void> {}

  async ensurePullRequest(): Promise<{
    number: number;
  }> {
    return {
      number: this.pullRequestNumber,
    };
  }

  async mergePullRequest(): Promise<MergePullRequestResult> {
    this.mergeCalls += 1;
    this.merged = true;
    return {
      mergeCommitSha: FAKE_MERGE_SHA,
    };
  }
}

export async function waitUntil(
  predicate: () =>
    | boolean
    | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();

  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        "waitUntil: timed out waiting for condition.",
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 5),
    );
  }
}
