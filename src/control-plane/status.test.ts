import test from "node:test";
import assert from "node:assert/strict";

import { deriveControlPlaneStatus } from "./status";

test("terminal workflow states map 1:1 regardless of liveness", () => {
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "DONE",
        failureKind: null,
        controlSignal: "NONE",
      },
      false,
    ),
    "DONE",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "CANCELLED",
        failureKind: null,
        controlSignal: "NONE",
      },
      true,
    ),
    "CANCELLED",
  );
});

test("FAILED maps to PAUSED_RESOURCE_LIMIT only with RESOURCE_LIMIT evidence", () => {
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "FAILED",
        failureKind: "RESOURCE_LIMIT",
        controlSignal: "NONE",
      },
      false,
    ),
    "PAUSED_RESOURCE_LIMIT",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "FAILED",
        failureKind: "TERMINAL",
        controlSignal: "NONE",
      },
      false,
    ),
    "FAILED",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "FAILED",
        failureKind: "TRANSIENT",
        controlSignal: "NONE",
      },
      false,
    ),
    "FAILED",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "FAILED",
        failureKind: "WORKFLOW",
        controlSignal: "NONE",
      },
      false,
    ),
    "FAILED",
  );
});

test("PAUSED and BLOCKED report RUNNING while a resume is actively in flight", () => {
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "PAUSED",
        failureKind: null,
        controlSignal: "NONE",
      },
      true,
    ),
    "RUNNING",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "PAUSED",
        failureKind: null,
        controlSignal: "NONE",
      },
      false,
    ),
    "PAUSED",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "BLOCKED",
        failureKind: null,
        controlSignal: "NONE",
      },
      true,
    ),
    "RUNNING",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "BLOCKED",
        failureKind: null,
        controlSignal: "NONE",
      },
      false,
    ),
    "BLOCKED",
  );
});

test("in-flight internal states report RUNNING or INTERRUPTED based on liveness", () => {
  for (const workflowState of [
    "PREPARING",
    "IMPLEMENTING",
    "REVIEWING",
    "MERGING",
  ] as const) {
    assert.equal(
      deriveControlPlaneStatus(
        {
          workflowState,
          failureKind: null,
          controlSignal: "NONE",
        },
        true,
      ),
      "RUNNING",
    );
    assert.equal(
      deriveControlPlaneStatus(
        {
          workflowState,
          failureKind: null,
          controlSignal: "NONE",
        },
        false,
      ),
      "INTERRUPTED",
    );
  }
});

test("a pending control signal takes priority over liveness for in-flight states", () => {
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "IMPLEMENTING",
        failureKind: null,
        controlSignal: "PAUSE_REQUESTED",
      },
      true,
    ),
    "PAUSE_REQUESTED",
  );
  assert.equal(
    deriveControlPlaneStatus(
      {
        workflowState: "REVIEWING",
        failureKind: null,
        controlSignal: "CANCEL_REQUESTED",
      },
      false,
    ),
    "CANCEL_REQUESTED",
  );
});
