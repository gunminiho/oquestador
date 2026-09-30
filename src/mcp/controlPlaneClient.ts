import type {
  RunSummary,
  TaskSummary,
} from "../control-plane/types";

export interface ControlPlaneHealth {
  status: string;
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class ControlPlaneHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<
      string,
      unknown
    >,
  ) {
    super(message);
  }
}

export class ControlPlaneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class ControlPlaneClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    options: ControlPlaneClientOptions,
  ) {
    if (!options.baseUrl.trim()) {
      throw new Error(
        "ORCHESTRATOR_CONTROL_URL is required.",
      );
    }

    if (!options.token.trim()) {
      throw new Error(
        "ORCHESTRATOR_CONTROL_TOKEN is required.",
      );
    }

    this.baseUrl = new URL(
      options.baseUrl,
    );
    this.token = options.token;
    this.timeoutMs =
      options.timeoutMs ?? 10_000;
    this.fetchFn =
      options.fetchFn ?? fetch;
  }

  async health(): Promise<ControlPlaneHealth> {
    return this.request<ControlPlaneHealth>(
      "GET",
      "/health",
      false,
    );
  }

  async listTasks(): Promise<TaskSummary[]> {
    const body = await this.request<{
      tasks: TaskSummary[];
    }>("GET", "/api/tasks", true);
    return body.tasks;
  }

  async getTask(
    taskId: string,
  ): Promise<TaskSummary> {
    return this.request<TaskSummary>(
      "GET",
      `/api/tasks/${encodeURIComponent(taskId)}`,
      true,
    );
  }

  async startTask(
    input: {
      taskId: string;
      agentProfileId?: string;
      stageAgentProfileIds?: Partial<Record<"PREPARATION" | "IMPLEMENTATION" | "REVIEW", string>>;
    },
  ): Promise<RunSummary> {
    return this.request<RunSummary>(
      "POST",
      "/api/runs",
      true,
      input,
    );
  }

  async listRuns(): Promise<RunSummary[]> {
    const body = await this.request<{
      runs: RunSummary[];
    }>("GET", "/api/runs", true);
    return body.runs;
  }

  async getRun(
    runId: string,
  ): Promise<RunSummary> {
    return this.request<RunSummary>(
      "GET",
      `/api/runs/${encodeURIComponent(runId)}`,
      true,
    );
  }

  async pauseRun(
    runId: string,
  ): Promise<RunSummary> {
    return this.runAction(runId, "pause");
  }

  async resumeRun(
    runId: string,
  ): Promise<RunSummary> {
    return this.runAction(runId, "resume");
  }

  async cancelRun(
    runId: string,
  ): Promise<RunSummary> {
    return this.runAction(runId, "cancel");
  }

  private async runAction(
    runId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<RunSummary> {
    return this.request<RunSummary>(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/${action}`,
      true,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    authenticated: boolean,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(
      path,
      this.baseUrl,
    );
    const controller =
      new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const headers: Record<string, string> =
        {
          Accept: "application/json",
        };

      if (authenticated) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      if (body !== undefined) {
        headers["Content-Type"] =
          "application/json";
      }

      const response =
        await this.fetchFn(url, {
          method,
          headers,
          body:
            body === undefined
              ? undefined
              : JSON.stringify(body),
          signal: controller.signal,
        });

      const payload =
        await parseJsonResponse(response);

      if (!response.ok) {
        const errorBody =
          asRecord(payload);
        throw new ControlPlaneHttpError(
          response.status,
          stringField(
            errorBody,
            "error",
            "http_error",
          ),
          stringField(
            errorBody,
            "message",
            `Control Plane returned HTTP ${response.status}.`,
          ),
          pickSafeDetails(errorBody),
        );
      }

      return payload as T;
    } catch (error: unknown) {
      if (
        error instanceof
          ControlPlaneHttpError
      ) {
        throw error;
      }

      if (
        error instanceof
          ControlPlaneUnavailableError
      ) {
        throw error;
      }

      const message =
        error instanceof Error &&
        error.name === "AbortError"
          ? "Control Plane request timed out."
          : "Control Plane is unreachable.";

      throw new ControlPlaneUnavailableError(
        message,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseJsonResponse(
  response: Response,
): Promise<unknown> {
  const text = await response.text();

  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new ControlPlaneUnavailableError(
        "Control Plane returned invalid JSON.",
      );
    }

    return {
      error: "http_error",
      message: `Control Plane returned HTTP ${response.status}.`,
    };
  }
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  return typeof value === "string"
    ? sanitize(value)
    : fallback;
}

function pickSafeDetails(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details: Record<string, unknown> =
    {};

  if (typeof record.existingRunId === "string") {
    details.existingRunId =
      record.existingRunId;
  }

  return Object.keys(details).length === 0
    ? undefined
    : details;
}

function sanitize(value: string): string {
  return value
    .replace(
      /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
      "Bearer [redacted]",
    )
    .replace(
      /ORCHESTRATOR_CONTROL_TOKEN=[^\s]+/g,
      "ORCHESTRATOR_CONTROL_TOKEN=[redacted]",
    );
}
