import {
  nextStateAfterReview,
  parseReviewerVerdict,
} from "./workflow";

const approved = parseReviewerVerdict(`
Resumen de revisión.

REVIEW_VERDICT: APPROVED
`);

const changes = parseReviewerVerdict(`
Se encontró un problema.

REVIEW_VERDICT: CHANGES_REQUESTED
`);

console.log({
  approved,
  approvedNextState: nextStateAfterReview(approved),
  changes,
  changesNextState: nextStateAfterReview(changes),
});
