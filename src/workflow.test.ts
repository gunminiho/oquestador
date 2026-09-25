import test from "node:test";
import assert from "node:assert/strict";

import {
  parseImplementationResult,
  parsePreparationResult,
} from "./workflow";

test(
  "preparation READY parses",
  () => {
    assert.deepEqual(
      parsePreparationResult(
        "PREPARATION_RESULT: READY",
      ),
      {
        status: "READY",
        reason: null,
      },
    );
  },
);

test(
  "implementation READY_FOR_REVIEW parses",
  () => {
    assert.deepEqual(
      parseImplementationResult(
        "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
      ),
      {
        status:
          "READY_FOR_REVIEW",
      },
    );
  },
);

test(
  "implementation NO_CHANGES_REQUIRED parses",
  () => {
    assert.deepEqual(
      parseImplementationResult(
        "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED",
      ),
      {
        status:
          "NO_CHANGES_REQUIRED",
      },
    );
  },
);

test(
  "implementation result rejects duplicates and invalid values",
  () => {
    assert.throws(
      () =>
        parseImplementationResult(
          [
            "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
            "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED",
          ].join("\n"),
        ),
      /Expected exactly one IMPLEMENTATION_RESULT/,
    );

    assert.throws(
      () =>
        parseImplementationResult(
          "IMPLEMENTATION_RESULT: DONE",
        ),
      /Expected exactly one IMPLEMENTATION_RESULT/,
    );
  },
);

test(
  "NO_CHANGES_REQUIRED rejects Pull Request numbers",
  () => {
    assert.throws(
      () =>
        parseImplementationResult(
          [
            "IMPLEMENTATION_RESULT: NO_CHANGES_REQUIRED",
            "PULL_REQUEST_NUMBER: 123",
          ].join("\n"),
        ),
      /must not include PULL_REQUEST_NUMBER/,
    );
  },
);

test(
  "preparation BLOCKED requires and preserves reason",
  () => {
    assert.deepEqual(
      parsePreparationResult(
        "PREPARATION_RESULT: BLOCKED\nPREPARATION_REASON: dirty tree",
      ),
      {
        status:
          "BLOCKED",
        reason:
          "dirty tree",
      },
    );

    assert.throws(
      () =>
        parsePreparationResult(
          "PREPARATION_RESULT: BLOCKED",
        ),
      /requires exactly one PREPARATION_REASON/,
    );
  },
);

test(
  "preparation invalid remains invalid",
  () => {
    assert.throws(
      () =>
        parsePreparationResult(
          "PREPARATION_RESULT: MAYBE",
        ),
      /Expected exactly one PREPARATION_RESULT/,
    );
  },
);
