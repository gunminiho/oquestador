export type WorkflowState =
  | "PREPARING"
  | "IMPLEMENTING"
  | "REVIEWING"
  | "MERGING"
  | "DONE"
  | "FAILED";

export type ReviewerVerdict =
  | "APPROVED"
  | "CHANGES_REQUESTED";

export function parseReviewerVerdict(
  response: string,
): ReviewerVerdict {
  const matches = [
    ...response.matchAll(
      /REVIEW_VERDICT:[ \t]*(APPROVED|CHANGES_REQUESTED)\b/g,
    ),
  ];

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one REVIEW_VERDICT, found ${matches.length}.`,
    );
  }

  const verdict = matches[0]?.[1];

  if (
    verdict !== "APPROVED" &&
    verdict !== "CHANGES_REQUESTED"
  ) {
    throw new Error("Invalid REVIEW_VERDICT value.");
  }

  return verdict;
}

export function nextStateAfterReview(
  verdict: ReviewerVerdict,
): WorkflowState {
  switch (verdict) {
    case "APPROVED":
      return "MERGING";

    case "CHANGES_REQUESTED":
      return "IMPLEMENTING";
  }
}


export type PreparationResult = "READY";

export function parsePreparationResult(
  response: string,
): PreparationResult {
  const matches = [
    ...response.matchAll(
      /PREPARATION_RESULT:[ \t]*(READY)\b/g,
    ),
  ];

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PREPARATION_RESULT, found ${matches.length}.`,
    );
  }

  return "READY";
}

export interface ImplementationResult {
  status: "READY_FOR_REVIEW";
  pullRequestNumber?: number;
}

export function parseImplementationResult(
  response: string,
): ImplementationResult {
  const statusMatches = [
    ...response.matchAll(
      /IMPLEMENTATION_RESULT:[ \t]*(READY_FOR_REVIEW)\b/g,
    ),
  ];

  if (statusMatches.length !== 1) {
    throw new Error(
      `Expected exactly one IMPLEMENTATION_RESULT, found ${statusMatches.length}.`,
    );
  }

  const pullRequestMatches = [
    ...response.matchAll(
      /PULL_REQUEST_NUMBER:[ \t]*(\d+)\b/g,
    ),
  ];

  if (pullRequestMatches.length > 1) {
    throw new Error(
      `Expected at most one PULL_REQUEST_NUMBER, found ${pullRequestMatches.length}.`,
    );
  }

  const rawPullRequestNumber =
    pullRequestMatches[0]?.[1];

  if (rawPullRequestNumber === undefined) {
    return {
      status: "READY_FOR_REVIEW",
    };
  }

  const pullRequestNumber =
    Number(rawPullRequestNumber);

  if (
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0
  ) {
    throw new Error(
      "PULL_REQUEST_NUMBER must be a positive integer.",
    );
  }

  return {
    status: "READY_FOR_REVIEW",
    pullRequestNumber,
  };
}
