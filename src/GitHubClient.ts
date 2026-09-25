import {
  execFile,
  spawn,
} from "node:child_process";
import { promisify } from "node:util";

const execFileAsync =
  promisify(execFile);

export interface PullRequestDetails {
  number: number;
  state:
    | "OPEN"
    | "CLOSED"
    | "MERGED";
  merged: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  mergeCommitSha: string | null;
}

export interface MergePullRequestResult {
  mergeCommitSha: string | null;
}

export interface GitHubClient {
  getPullRequest(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
  }): Promise<PullRequestDetails>;

  mergePullRequest(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }): Promise<MergePullRequestResult>;

  ensureBranchPublished?(options: {
    owner: string;
    repo: string;
    workspace: string;
    branch: string;
  }): Promise<void>;

  ensurePullRequest?(options: {
    owner: string;
    repo: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  }): Promise<{
    number: number;
  }>;
}

export interface GitHubCommandExecutor {
  exec(
    file: string,
    args: string[],
  ): Promise<{
    stdout: string;
  }>;

  execWithInput(
    file: string,
    args: string[],
    input: string,
  ): Promise<void>;
}

const DEFAULT_COMMAND_EXECUTOR:
  GitHubCommandExecutor = {
    exec: execText,
    execWithInput:
      spawnWithInput,
  };

export class GhCliGitHubClient
implements GitHubClient {
  constructor(
    private readonly agentContainerName =
      process.env.OH_AGENT_CONTAINER ??
      "openhands-canvas",
    private readonly commands:
      GitHubCommandExecutor =
        DEFAULT_COMMAND_EXECUTOR,
  ) {}

  async getPullRequest(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
  }): Promise<PullRequestDetails> {
    const { stdout } =
      await this.commands.exec(
        "gh",
        [
          "pr",
          "view",
          String(
            options.pullRequestNumber,
          ),
          "--repo",
          `${options.owner}/${options.repo}`,
          "--json",
          [
            "number",
            "state",
            "baseRefName",
            "headRefName",
            "headRefOid",
            "headRepositoryOwner",
            "headRepository",
            "mergeCommit",
          ].join(","),
        ],
      );

    const parsed =
      JSON.parse(stdout) as {
        number: number;
        state:
          | "OPEN"
          | "CLOSED"
          | "MERGED";
        baseRefName: string;
        headRefName: string;
        headRefOid: string;
        headRepositoryOwner: {
          login: string;
        };
        headRepository: {
          name: string;
        };
        mergeCommit: {
          oid: string;
        } | null;
      };

    return {
      number: parsed.number,
      state: parsed.state,
      merged:
        parsed.state === "MERGED",
      baseRefName:
        parsed.baseRefName,
      headRefName:
        parsed.headRefName,
      headRefOid:
        parsed.headRefOid,
      headRepositoryOwner:
        parsed
          .headRepositoryOwner
          .login,
      headRepositoryName:
        parsed.headRepository.name,
      mergeCommitSha:
        parsed.mergeCommit?.oid ??
        null,
    };
  }

  async mergePullRequest(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }): Promise<MergePullRequestResult> {
    await this.commands.exec(
      "gh",
      [
        "pr",
        "merge",
        String(
          options.pullRequestNumber,
        ),
        "--repo",
        `${options.owner}/${options.repo}`,
        "--merge",
        "--match-head-commit",
        options.expectedHeadSha,
      ],
    );

    const pullRequest =
      await this.getPullRequest(
        options,
      );

    return {
      mergeCommitSha:
        pullRequest.mergeCommitSha,
    };
  }

  async ensureBranchPublished(
    options: {
      owner: string;
      repo: string;
      workspace: string;
      branch: string;
    },
  ): Promise<void> {
    await this.commands.exec(
      "docker",
      [
        "exec",
        this.agentContainerName,
        "git",
        "-C",
        options.workspace,
        "rev-parse",
        "HEAD",
      ],
    );

    const {
      stdout: statusStdout,
    } = await this.commands.exec(
      "docker",
      [
        "exec",
        this.agentContainerName,
        "git",
        "-C",
        options.workspace,
        "status",
        "--porcelain",
      ],
    );

    if (
      statusStdout.trim() !==
      ""
    ) {
      throw new Error(
        `Workspace ${options.workspace} has uncommitted changes; refusing to publish the branch.`,
      );
    }

    const {
      stdout: remoteStdout,
    } = await this.commands.exec(
      "docker",
      [
        "exec",
        this.agentContainerName,
        "git",
        "-C",
        options.workspace,
        "remote",
        "get-url",
        "origin",
      ],
    );

    if (
      !isExpectedGitHubRemote(
        remoteStdout.trim(),
        options.owner,
        options.repo,
      )
    ) {
      throw new Error(
        `Workspace origin does not match ${options.owner}/${options.repo}.`,
      );
    }

    const {
      stdout: tokenStdout,
    } = await this.commands.exec(
      "gh",
      [
        "auth",
        "token",
      ],
    );

    const token =
      tokenStdout.trim();

    if (!token) {
      throw new Error(
        "GitHub authentication is unavailable to the orchestrator.",
      );
    }

    const script = [
      "set -eu",
      "IFS= read -r TOKEN",
      'cred="$(mktemp)"',
      "trap 'rm -f \"$cred\"' EXIT",
      "printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n\\n' \"$TOKEN\" | git credential-store --file=\"$cred\" store",
      'git -C "$WORKSPACE" -c credential.helper="store --file=$cred" push origin "HEAD:refs/heads/$BRANCH"',
    ].join("\n");

    await this.commands
      .execWithInput(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          `WORKSPACE=${options.workspace}`,
          "-e",
          `BRANCH=${options.branch}`,
          this.agentContainerName,
          "sh",
          "-lc",
          script,
        ],
        `${token}\n`,
      );
  }

  async ensurePullRequest(
    options: {
      owner: string;
      repo: string;
      baseBranch: string;
      headBranch: string;
      title: string;
      body: string;
    },
  ): Promise<{
    number: number;
  }> {
    const repository =
      `${options.owner}/${options.repo}`;

    const existing =
      await this.findOpenPullRequests(
        repository,
        options.baseBranch,
        options.headBranch,
      );

    if (
      existing.length > 1
    ) {
      throw new Error(
        `Multiple open Pull Requests exist for ${options.headBranch} -> ${options.baseBranch}.`,
      );
    }

    if (
      existing[0] !== undefined
    ) {
      return {
        number: existing[0],
      };
    }

    await this.commands.exec(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        options.baseBranch,
        "--head",
        options.headBranch,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
    );

    const created =
      await this.findOpenPullRequests(
        repository,
        options.baseBranch,
        options.headBranch,
      );

    if (
      created.length !== 1 ||
      created[0] === undefined
    ) {
      throw new Error(
        "Pull Request creation could not be confirmed.",
      );
    }

    return {
      number: created[0],
    };
  }

  private async findOpenPullRequests(
    repository: string,
    baseBranch: string,
    headBranch: string,
  ): Promise<number[]> {
    const { stdout } =
      await this.commands.exec(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--state",
          "open",
          "--base",
          baseBranch,
          "--head",
          headBranch,
          "--json",
          "number",
          "--limit",
          "10",
        ],
      );

    const parsed =
      JSON.parse(stdout) as Array<{
        number: number;
      }>;

    return parsed.map(
      (item) => item.number,
    );
  }
}

async function execText(
  file: string,
  args: string[],
): Promise<{
  stdout: string;
}> {
  const {
    stdout,
  } = await execFileAsync(
    file,
    args,
    {
      encoding: "utf8",
    },
  );

  return {
    stdout,
  };
}

async function spawnWithInput(
  file: string,
  args: string[],
  input: string,
): Promise<void> {
  await new Promise<void>(
    (
      resolve,
      reject,
    ) => {
      const child = spawn(
        file,
        args,
        {
          stdio: [
            "pipe",
            "pipe",
            "pipe",
          ],
        },
      );

      let stderr = "";

      child.stdout.resume();

      child.stderr.setEncoding(
        "utf8",
      );

      child.stderr.on(
        "data",
        (
          chunk: string,
        ) => {
          stderr += chunk;
        },
      );

      child.on(
        "error",
        reject,
      );

      child.on(
        "close",
        (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              `Command failed (${file}) with exit code ${String(code)}: ${stderr.trim()}`,
            ),
          );
        },
      );

      child.stdin.end(input);
    },
  );
}

export function isExpectedGitHubRemote(
  remote: string,
  owner: string,
  repo: string,
): boolean {
  const normalized =
    remote
      .trim()
      .replace(
        /\.git$/,
        "",
      );

  return (
    normalized ===
      `https://github.com/${owner}/${repo}` ||
    normalized ===
      `git@github.com:${owner}/${repo}` ||
    normalized ===
      `ssh://git@github.com/${owner}/${repo}`
  );
}
