import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  CONTROL_PLANE_STATE_VERSION,
  type ControlPlaneRunRecord,
} from "./types";

const RUN_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const JSON_SUFFIX = ".json";

export class ControlPlaneStore {
  constructor(
    private readonly baseDir = ".orchestrator/control-plane/runs",
  ) {}

  load(
    runId: string,
  ): ControlPlaneRunRecord | null {
    const filePath =
      this.filePath(runId);

    if (!existsSync(filePath)) {
      return null;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(
        readFileSync(filePath, "utf8"),
      );
    } catch (error: unknown) {
      throw new Error(
        `Invalid ControlPlaneRunRecord JSON for run ${runId}: ${filePath}`,
        { cause: error },
      );
    }

    return validateRecord(parsed, runId);
  }

  save(
    record: ControlPlaneRunRecord,
  ): void {
    validateRecord(record, record.runId);

    const filePath =
      this.filePath(record.runId);
    mkdirSync(dirname(filePath), {
      recursive: true,
    });

    const nextRecord: ControlPlaneRunRecord = {
      ...record,
      updatedAt:
        new Date().toISOString(),
    };

    const temporaryPath =
      `${filePath}.${process.pid}.${Date.now()}.tmp`;

    writeFileSync(
      temporaryPath,
      `${JSON.stringify(nextRecord, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, filePath);
  }

  list(): ControlPlaneRunRecord[] {
    if (!existsSync(this.baseDir)) {
      return [];
    }

    return readdirSync(this.baseDir)
      .filter((name) =>
        name.endsWith(JSON_SUFFIX),
      )
      .map((name) =>
        name.slice(
          0,
          -JSON_SUFFIX.length,
        ),
      )
      .map((runId) => this.load(runId))
      .filter(
        (
          record,
        ): record is ControlPlaneRunRecord =>
          record !== null,
      );
  }

  filePath(runId: string): string {
    return join(
      this.baseDir,
      `${safeRunId(runId)}${JSON_SUFFIX}`,
    );
  }
}

function safeRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "runId may only contain letters, numbers, and hyphens.",
    );
  }

  return runId;
}

function validateRecord(
  value: unknown,
  expectedRunId?: string,
): ControlPlaneRunRecord {
  if (!isRecord(value)) {
    throw new Error(
      "ControlPlaneRunRecord must be an object.",
    );
  }

  assertEqual(
    value.version,
    CONTROL_PLANE_STATE_VERSION,
    "ControlPlaneRunRecord.version",
  );
  assertNonEmptyString(
    value.runId,
    "ControlPlaneRunRecord.runId",
  );

  if (
    expectedRunId !== undefined &&
    value.runId !== expectedRunId
  ) {
    throw new Error(
      `ControlPlaneRunRecord.runId must be ${expectedRunId}, got ${String(value.runId)}.`,
    );
  }

  assertNonEmptyString(
    value.taskId,
    "ControlPlaneRunRecord.taskId",
  );
  assertNonEmptyString(
    value.agentProfileId,
    "ControlPlaneRunRecord.agentProfileId",
  );
  assertNonEmptyString(
    value.workspace,
    "ControlPlaneRunRecord.workspace",
  );
  assertNonEmptyString(
    value.createdAt,
    "ControlPlaneRunRecord.createdAt",
  );
  assertNonEmptyString(
    value.updatedAt,
    "ControlPlaneRunRecord.updatedAt",
  );

  return value as unknown as ControlPlaneRunRecord;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function assertEqual(
  value: unknown,
  expected: unknown,
  field: string,
): void {
  if (value !== expected) {
    throw new Error(
      `${field} must be ${String(expected)}.`,
    );
  }
}

function assertNonEmptyString(
  value: unknown,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `${field} must be a non-empty string.`,
    );
  }
}
