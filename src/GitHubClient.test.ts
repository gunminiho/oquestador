import test from "node:test";
import assert from "node:assert/strict";

import {
  GhCliGitHubClient,
  type GitHubCommandExecutor,
  isExpectedGitHubRemote,
} from "./GitHubClient";

class FakeCommands
implements GitHubCommandExecutor {
  readonly calls: Array<{
    file: string;
    args: string[];
    input?: string;
  }> = [];

  private prLists:
    string[] = [];

  dirtyStatus = "";
  remote =
    "https://github.com/gunminiho/oquestador.git";
  token =
    "test-token";

  queuePrList(
    value: Array<{
      number: number;
    }>,
  ): void {
    this.prLists.push(
      JSON.stringify(value),
    );
  }

  async exec(
    file: string,
    args: string[],
  ): Promise<{
    stdout: string;
  }> {
    this.calls.push({
      file,
      args: [...args],
    });

    if (
      file === "docker" &&
      args.includes(
        "rev-parse",
      )
    ) {
      return {
        stdout:
          "1111111111111111111111111111111111111111\n",
      };
    }

    if (
      file === "docker" &&
      args.includes(
        "--porcelain",
      )
    ) {
      return {
        stdout:
          this.dirtyStatus,
      };
    }

    if (
      file === "docker" &&
      args.includes(
        "get-url",
      )
    ) {
      return {
        stdout:
          `${this.remote}\n`,
      };
    }

    if (
      file === "gh" &&
      args[0] === "auth" &&
      args[1] === "token"
    ) {
      return {
        stdout:
          `${this.token}\n`,
      };
    }

    if (
      file === "gh" &&
      args[0] === "pr" &&
      args[1] === "list"
    ) {
      const next =
        this.prLists.shift();

      if (
        next === undefined
      ) {
        throw new Error(
          "Missing queued PR list response.",
        );
      }

      return {
        stdout: next,
      };
    }

    if (
      file === "gh" &&
      args[0] === "pr" &&
      args[1] === "create"
    ) {
      return {
        stdout: "",
      };
    }

    throw new Error(
      `Unexpected command: ${file} ${args.join(" ")}`,
    );
  }

  async execWithInput(
    file: string,
    args: string[],
    input: string,
  ): Promise<void> {
    this.calls.push({
      file,
      args: [...args],
      input,
    });
  }
}

test(
  "validates GitHub origin before credentialed push",
  () => {
    assert.equal(
      isExpectedGitHubRemote(
        "https://github.com/gunminiho/oquestador.git",
        "gunminiho",
        "oquestador",
      ),
      true,
    );

    assert.equal(
      isExpectedGitHubRemote(
        "git@github.com:gunminiho/oquestador.git",
        "gunminiho",
        "oquestador",
      ),
      true,
    );

    assert.equal(
      isExpectedGitHubRemote(
        "https://evil.example/gunminiho/oquestador.git",
        "gunminiho",
        "oquestador",
      ),
      false,
    );
  },
);

test(
  "ensureBranchPublished accepts detached HEAD and pushes exact HEAD to the configured remote branch",
  async () => {
    const commands =
      new FakeCommands();

    const client =
      new GhCliGitHubClient(
        "openhands-canvas",
        commands,
      );

    await client
      .ensureBranchPublished({
        owner: "gunminiho",
        repo: "oquestador",
        workspace:
          "/projects/task",
        branch:
          "feat/task",
      });

    const publishCall =
      commands.calls.find(
        (
          call,
        ) =>
          call.input ===
          "test-token\n",
      );

    assert.ok(
      publishCall,
    );

    assert.equal(
      publishCall.file,
      "docker",
    );

    const shellScript =
      publishCall.args.at(-1) ??
      "";

    assert.match(
      shellScript,
      /push origin "HEAD:refs\/heads\/\$BRANCH"/,
    );

    assert.doesNotMatch(
      shellScript,
      /--set-upstream/,
    );
  },
);

test(
  "ensureBranchPublished refuses dirty worktree before reading a token",
  async () => {
    const commands =
      new FakeCommands();

    commands.dirtyStatus =
      " M src/file.ts\n";

    const client =
      new GhCliGitHubClient(
        "openhands-canvas",
        commands,
      );

    await assert.rejects(
      client
        .ensureBranchPublished({
          owner:
            "gunminiho",
          repo:
            "oquestador",
          workspace:
            "/projects/task",
          branch:
            "feat/task",
        }),
      /uncommitted changes/,
    );

    assert.equal(
      commands.calls.some(
        (call) =>
          call.file ===
            "gh" &&
          call.args[0] ===
            "auth",
      ),
      false,
    );
  },
);

test(
  "ensureBranchPublished rejects unexpected origin before reading token",
  async () => {
    const commands =
      new FakeCommands();

    commands.remote =
      "https://evil.example/repo.git";

    const client =
      new GhCliGitHubClient(
        "openhands-canvas",
        commands,
      );

    await assert.rejects(
      client
        .ensureBranchPublished({
          owner:
            "gunminiho",
          repo:
            "oquestador",
          workspace:
            "/projects/task",
          branch:
            "feat/task",
        }),
      /origin does not match/,
    );

    assert.equal(
      commands.calls.some(
        (call) =>
          call.file ===
            "gh" &&
          call.args[0] ===
            "auth",
      ),
      false,
    );
  },
);

test(
  "ensurePullRequest reuses existing matching PR without creating another",
  async () => {
    const commands =
      new FakeCommands();

    commands.queuePrList([
      {
        number: 17,
      },
    ]);

    const client =
      new GhCliGitHubClient(
        "openhands-canvas",
        commands,
      );

    const result =
      await client
        .ensurePullRequest({
          owner:
            "gunminiho",
          repo:
            "oquestador",
          baseBranch:
            "main",
          headBranch:
            "feat/task",
          title:
            "Task",
          body:
            "Body",
        });

    assert.equal(
      result.number,
      17,
    );

    assert.equal(
      commands.calls.some(
        (call) =>
          call.file ===
            "gh" &&
          call.args[0] ===
            "pr" &&
          call.args[1] ===
            "create",
      ),
      false,
    );
  },
);

test(
  "ensurePullRequest creates once and confirms the created PR",
  async () => {
    const commands =
      new FakeCommands();

    commands.queuePrList([]);
    commands.queuePrList([
      {
        number: 18,
      },
    ]);

    const client =
      new GhCliGitHubClient(
        "openhands-canvas",
        commands,
      );

    const result =
      await client
        .ensurePullRequest({
          owner:
            "gunminiho",
          repo:
            "oquestador",
          baseBranch:
            "main",
          headBranch:
            "feat/task",
          title:
            "Task",
          body:
            "Body",
        });

    assert.equal(
      result.number,
      18,
    );

    assert.equal(
      commands.calls.filter(
        (call) =>
          call.file ===
            "gh" &&
          call.args[0] ===
            "pr" &&
          call.args[1] ===
            "create",
      ).length,
      1,
    );
  },
);

test(
  "ensurePullRequest rejects ambiguous duplicate open PRs",
  async () => {
    const commands =
      new FakeCommands();

    commands.queuePrList([
      {
        number: 1,
      },
      {
        number: 2,
      },
    ]);

    const client =
      new GhCliGitHubClient(
        "openhands-canvas",
        commands,
      );

    await assert.rejects(
      client
        .ensurePullRequest({
          owner:
            "gunminiho",
          repo:
            "oquestador",
          baseBranch:
            "main",
          headBranch:
            "feat/task",
          title:
            "Task",
          body:
            "Body",
        }),
      /Multiple open Pull Requests/,
    );
  },
);
