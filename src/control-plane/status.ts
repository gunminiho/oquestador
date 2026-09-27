import type { RunState } from "../runState";
import type { ControlPlaneStatus } from "./types";

/**
 * Maps the internal WorkflowState machine plus the in-process liveness bit
 * onto the unambiguous public Control Plane status. `isActiveInMemory`
 * distinguishes a run this process is currently driving (RUNNING) from one
 * that was left in flight by a previous process life (INTERRUPTED) after a
 * restart — both look identical in RunState alone.
 */
export function deriveControlPlaneStatus(
  runState: Pick<
    RunState,
    "workflowState" | "failureKind" | "controlSignal"
  >,
  isActiveInMemory: boolean,
): ControlPlaneStatus {
  switch (runState.workflowState) {
    case "DONE":
      return "DONE";
    case "CANCELLED":
      return "CANCELLED";
    case "PAUSED":
      // A resume can be kicked off (isActiveInMemory becomes true)
      // before the engine has had a chance to flip the persisted
      // workflowState away from PAUSED; prefer the live signal so the
      // response to POST /resume does not look like a no-op.
      return isActiveInMemory
        ? "RUNNING"
        : "PAUSED";
    case "BLOCKED":
      return isActiveInMemory
        ? "RUNNING"
        : "BLOCKED";
    case "FAILED":
      if (
        runState.failureKind ===
        "RESOURCE_LIMIT"
      ) {
        return isActiveInMemory
          ? "RUNNING"
          : "PAUSED_RESOURCE_LIMIT";
      }

      return "FAILED";
    case "PREPARING":
    case "IMPLEMENTING":
    case "REVIEWING":
    case "MERGING":
      if (
        runState.controlSignal ===
        "PAUSE_REQUESTED"
      ) {
        return "PAUSE_REQUESTED";
      }

      if (
        runState.controlSignal ===
        "CANCEL_REQUESTED"
      ) {
        return "CANCEL_REQUESTED";
      }

      return isActiveInMemory
        ? "RUNNING"
        : "INTERRUPTED";
  }
}
