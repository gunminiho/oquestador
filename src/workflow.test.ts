import test from "node:test";
import assert from "node:assert/strict";

import {
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
