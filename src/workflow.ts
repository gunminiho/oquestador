export type WorkflowState =
  | "PREPARING"
  | "BLOCKED"
  | "IMPLEMENTING"
  | "REVIEWING"
  | "MERGING"
  | "PAUSED"
  | "CANCELLED"
  | "DONE"
  | "FAILED";

export type ReviewerVerdict =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "BLOCKED_EXTERNAL";

const BLOCKER_KEY_PATTERN =
  /^[A-Za-z0-9._:-]+$/;

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
  options: {
    noChangesRequired?: boolean;
  } = {},
): WorkflowState {
  switch (verdict) {
    case "APPROVED":
      if (
        options.noChangesRequired ===
        true
      ) {
        return "DONE";
      }

      return "MERGING";
    case "CHANGES_REQUESTED":
      return "IMPLEMENTING";
    case "BLOCKED_EXTERNAL":
      return "BLOCKED";
  }
}

export interface ReviewOutcome {
  verdict: ReviewerVerdict;
  reason: string | null;
  blockerKey: string | null;
}

export function parseReviewOutcome(
  response: string,
): ReviewOutcome {
  const matches = [
    ...response.matchAll(
      /REVIEW_VERDICT:[ \t]*(APPROVED|CHANGES_REQUESTED|BLOCKED_EXTERNAL)\b/g,
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
    verdict !== "CHANGES_REQUESTED" &&
    verdict !== "BLOCKED_EXTERNAL"
  ) {
    throw new Error("Invalid REVIEW_VERDICT value.");
  }

  const reasonMatches = [
    ...response.matchAll(
      /^REVIEW_REASON:[ \t]*(.+)$/gm,
    ),
  ];

  if (reasonMatches.length > 1) {
    throw new Error(
      `Expected at most one REVIEW_REASON, found ${reasonMatches.length}.`,
    );
  }

  const reason = reasonMatches[0]?.[1]?.trim() ?? null;

  if (verdict === "BLOCKED_EXTERNAL" && !reason) {
    throw new Error(
      "REVIEW_VERDICT: BLOCKED_EXTERNAL requires exactly one REVIEW_REASON.",
    );
  }

  const blockerKey = parseBlockerKey(response);

  return { verdict, reason, blockerKey };
}

function parseBlockerKey(
  response: string,
): string | null {
  const blockerKeyMatches = [
    ...response.matchAll(
      /^BLOCKER_KEY:[ \t]*(.+)$/gm,
    ),
  ];

  if (blockerKeyMatches.length > 1) {
    throw new Error(
      `Expected at most one BLOCKER_KEY, found ${blockerKeyMatches.length}.`,
    );
  }

  const blockerKey =
    blockerKeyMatches[0]?.[1]?.trim() ?? null;

  if (
    blockerKey !== null &&
    !BLOCKER_KEY_PATTERN.test(blockerKey)
  ) {
    throw new Error(
      "BLOCKER_KEY must contain only letters, numbers, dots, colons, underscores, and hyphens.",
    );
  }

  return blockerKey;
}

export interface PreparationResult {
  status: "READY" | "BLOCKED";
  reason: string | null;
}

export function parsePreparationResult(
  response: string,
): PreparationResult {
  const matches = [
    ...response.matchAll(
      /PREPARATION_RESULT:[ \t]*(READY|BLOCKED)\b/g,
    ),
  ];

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PREPARATION_RESULT, found ${matches.length}.`,
    );
  }

  const status = matches[0]?.[1];

  if (
    status !== "READY" &&
    status !== "BLOCKED"
  ) {
    throw new Error("Invalid PREPARATION_RESULT value.");
  }

  const reasonMatches = [
    ...response.matchAll(
      /^PREPARATION_REASON:[ \t]*(.+)$/gm,
    ),
  ];

  if (reasonMatches.length > 1) {
    throw new Error(
      `Expected at most one PREPARATION_REASON, found ${reasonMatches.length}.`,
    );
  }

  const reason = reasonMatches[0]?.[1]?.trim() ?? null;

  if (status === "BLOCKED" && !reason) {
    throw new Error(
      "PREPARATION_RESULT: BLOCKED requires exactly one PREPARATION_REASON.",
    );
  }

  return { status, reason };
}

export interface ImplementationResult {
  status:
    | "READY_FOR_REVIEW"
    | "NO_CHANGES_REQUIRED"
    | "BLOCKED_EXTERNAL";
  pullRequestNumber?: number;
  reason?: string;
  blockerKey?: string;
}

export function parseImplementationResult(
  response: string,
): ImplementationResult {
  const statusMatches = [
    ...response.matchAll(
      /IMPLEMENTATION_RESULT:[ \t]*(READY_FOR_REVIEW|NO_CHANGES_REQUIRED|BLOCKED_EXTERNAL)\b/g,
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

  const status =
    statusMatches[0]?.[1];

  if (
    status !== "READY_FOR_REVIEW" &&
    status !== "NO_CHANGES_REQUIRED" &&
    status !== "BLOCKED_EXTERNAL"
  ) {
    throw new Error(
      "Invalid IMPLEMENTATION_RESULT value.",
    );
  }

  if (
    status === "NO_CHANGES_REQUIRED" &&
    rawPullRequestNumber !== undefined
  ) {
    throw new Error(
      "NO_CHANGES_REQUIRED must not include PULL_REQUEST_NUMBER.",
    );
  }

  if (status === "BLOCKED_EXTERNAL") {
    if (rawPullRequestNumber !== undefined) {
      throw new Error(
        "BLOCKED_EXTERNAL must not include PULL_REQUEST_NUMBER.",
      );
    }

    const reasonMatches = [
      ...response.matchAll(
        /^IMPLEMENTATION_REASON:[ \t]*(.+)$/gm,
      ),
    ];

    if (reasonMatches.length !== 1) {
      throw new Error(
        "IMPLEMENTATION_RESULT: BLOCKED_EXTERNAL requires exactly one IMPLEMENTATION_REASON.",
      );
    }

    const reason = reasonMatches[0]?.[1]?.trim() ?? "";

    if (!reason) {
      throw new Error(
        "IMPLEMENTATION_RESULT: BLOCKED_EXTERNAL requires exactly one IMPLEMENTATION_REASON.",
      );
    }

    const blockerKey = parseBlockerKey(response);

    return {
      status,
      reason,
      ...(blockerKey !== null
        ? { blockerKey }
        : {}),
    };
  }

  if (rawPullRequestNumber === undefined) {
    return {
      status,
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
    status,
    pullRequestNumber,
  };
}
