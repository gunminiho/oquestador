export type WorkflowState =
  | "IMPLEMENTING"
  | "REVIEWING"
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
      return "DONE";

    case "CHANGES_REQUESTED":
      return "IMPLEMENTING";
  }
}
