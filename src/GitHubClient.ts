import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PullRequestDetails {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
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
}

export class GhCliGitHubClient implements GitHubClient {
  async getPullRequest(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
  }): Promise<PullRequestDetails> {
    const { stdout } = await execFileAsync("gh", [
      "pr",
      "view",
      String(options.pullRequestNumber),
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
    ]);

    const parsed = JSON.parse(stdout) as {
      number: number;
      state: "OPEN" | "CLOSED" | "MERGED";
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      headRepositoryOwner: { login: string };
      headRepository: { name: string };
      mergeCommit: { oid: string } | null;
    };

    return {
      number: parsed.number,
      state: parsed.state,
      merged: parsed.state === "MERGED",
      baseRefName: parsed.baseRefName,
      headRefName: parsed.headRefName,
      headRefOid: parsed.headRefOid,
      headRepositoryOwner: parsed.headRepositoryOwner.login,
      headRepositoryName: parsed.headRepository.name,
      mergeCommitSha: parsed.mergeCommit?.oid ?? null,
    };
  }

  async mergePullRequest(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }): Promise<MergePullRequestResult> {
    await execFileAsync("gh", [
      "pr",
      "merge",
      String(options.pullRequestNumber),
      "--repo",
      `${options.owner}/${options.repo}`,
      "--merge",
      "--match-head-commit",
      options.expectedHeadSha,
    ]);

    const pullRequest = await this.getPullRequest(options);

    return {
      mergeCommitSha: pullRequest.mergeCommitSha,
    };
  }
}
