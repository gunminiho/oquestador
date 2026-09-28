import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { checkControlToken } from "./auth";
import type { RunManager } from "./runManager";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "./types";

export interface ControlPlaneServerOptions {
  runManager: RunManager;
  controlToken: string;
  host?: string;
  port?: number;
}

export interface ControlPlaneServer {
  readonly server: Server;
  listen(): Promise<{
    host: string;
    port: number;
  }>;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;
const RUN_ACTION_PATTERN =
  /^\/api\/runs\/([^/]+)\/(pause|resume|cancel)$/;
const RUN_ITEM_PATTERN =
  /^\/api\/runs\/([^/]+)$/;
const TASK_ITEM_PATTERN =
  /^\/api\/tasks\/([^/]+)$/;

/**
 * Minimal, dependency-free HTTP Control Plane built on node:http. No web
 * framework: routing is a handful of exact-path/regex checks below, and
 * bodies are read and JSON-parsed by hand with a size cap. Binds to
 * loopback by default; BOOT-02 can widen host/port through the options
 * already exposed here.
 */
export function createControlPlaneServer(
  options: ControlPlaneServerOptions,
): ControlPlaneServer {
  if (
    !options.controlToken ||
    options.controlToken.trim() === ""
  ) {
    throw new Error(
      "Refusing to start the Control Plane in write mode without a control token. Set ORCHESTRATOR_CONTROL_TOKEN.",
    );
  }

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  let shuttingDown = false;

  const server = createServer(
    (req, res) => {
      handleRequest(
        req,
        res,
        options.runManager,
        options.controlToken,
        () => shuttingDown,
      ).catch((error: unknown) => {
        console.error(
          "Control Plane request handling failed:",
          error instanceof Error
            ? error.message
            : error,
        );

        if (!res.headersSent) {
          sendJson(res, 500, {
            error: "internal_error",
            message:
              "Unexpected internal error.",
          });
        }
      });
    },
  );

  return {
    server,

    async listen() {
      await new Promise<void>(
        (resolvePromise, reject) => {
          server.once(
            "error",
            reject,
          );
          server.listen(
            port,
            host,
            () => {
              server.removeListener(
                "error",
                reject,
              );
              resolvePromise();
            },
          );
        },
      );

      const address =
        server.address();
      const boundPort =
        typeof address === "object" &&
        address !== null
          ? address.port
          : port;

      return {
        host,
        port: boundPort,
      };
    },

    async close() {
      shuttingDown = true;
      options.runManager.shutdown();

      await new Promise<void>(
        (resolvePromise, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolvePromise();
            }
          });
        },
      );
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runManager: RunManager,
  controlToken: string,
  isShuttingDown: () => boolean,
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = safePathname(req.url);

  if (pathname === null) {
    sendJson(res, 400, {
      error: "invalid_request",
      message: "Malformed request URL.",
    });
    return;
  }

  if (
    method === "GET" &&
    pathname === "/health"
  ) {
    sendJson(res, 200, {
      status: "ok",
    });
    return;
  }

  const authResult = checkControlToken(
    req.headers.authorization,
    controlToken,
  );

  if (authResult === "MISSING") {
    sendJson(res, 401, {
      error: "unauthorized",
      message:
        "Missing or malformed Authorization header.",
    });
    return;
  }

  if (authResult === "INVALID") {
    sendJson(res, 403, {
      error: "forbidden",
      message: "Invalid control token.",
    });
    return;
  }

  if (
    method === "GET" &&
    pathname === "/api/tasks"
  ) {
    try {
      sendJson(res, 200, {
        tasks: runManager.listTasks(),
      });
    } catch (error: unknown) {
      sendManagerError(res, error);
    }

    return;
  }

  const taskMatch =
    TASK_ITEM_PATTERN.exec(pathname);

  if (
    method === "GET" &&
    taskMatch !== null
  ) {
    const taskId = decodeURIComponent(
      taskMatch[1] ?? "",
    );

    try {
      sendJson(
        res,
        200,
        runManager.getTask(taskId),
      );
    } catch (error: unknown) {
      sendManagerError(res, error);
    }

    return;
  }

  if (
    method === "GET" &&
    pathname === "/api/runs"
  ) {
    sendJson(res, 200, {
      runs: runManager.listRuns(),
    });
    return;
  }

  if (
    method === "POST" &&
    pathname === "/api/runs"
  ) {
    if (isShuttingDown()) {
      sendJson(res, 503, {
        error: "unavailable",
        message:
          "Control Plane is shutting down and not accepting new runs.",
      });
      return;
    }

    let body: unknown;

    try {
      body = await readJsonBody(req);
    } catch (error: unknown) {
      sendJson(res, 400, {
        error: "invalid_request",
        message: errorMessage(error),
      });
      return;
    }

    const { taskId, agentProfileId } =
      asStartRunBody(body);

    try {
      const summary =
        await runManager.startRun({
          taskId,
          agentProfileId,
        });
      sendJson(res, 202, summary);
    } catch (error: unknown) {
      sendManagerError(res, error);
    }

    return;
  }

  const actionMatch =
    RUN_ACTION_PATTERN.exec(pathname);

  if (
    method === "POST" &&
    actionMatch !== null
  ) {
    const runId = decodeURIComponent(
      actionMatch[1] ?? "",
    );
    const action = actionMatch[2];

    try {
      const summary =
        action === "pause"
          ? await runManager.pauseRun(
              runId,
            )
          : action === "resume"
            ? await runManager.resumeRun(
                runId,
              )
            : await runManager.cancelRun(
                runId,
              );

      sendJson(res, 202, summary);
    } catch (error: unknown) {
      sendManagerError(res, error);
    }

    return;
  }

  const itemMatch =
    RUN_ITEM_PATTERN.exec(pathname);

  if (
    method === "GET" &&
    itemMatch !== null
  ) {
    const runId = decodeURIComponent(
      itemMatch[1] ?? "",
    );

    try {
      sendJson(
        res,
        200,
        runManager.getRun(runId),
      );
    } catch (error: unknown) {
      sendManagerError(res, error);
    }

    return;
  }

  sendJson(res, 404, {
    error: "not_found",
    message: "Unknown route.",
  });
}

function asStartRunBody(
  body: unknown,
): {
  taskId: unknown;
  agentProfileId: unknown;
} {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    throw new ValidationError(
      "Request body must be a JSON object.",
    );
  }

  const record =
    body as Record<string, unknown>;

  return {
    taskId: record.taskId,
    agentProfileId:
      record.agentProfileId,
  };
}

function sendManagerError(
  res: ServerResponse,
  error: unknown,
): void {
  if (error instanceof ValidationError) {
    sendJson(res, 400, {
      error: "invalid_request",
      message: error.message,
    });
    return;
  }

  if (error instanceof NotFoundError) {
    sendJson(res, 404, {
      error: "not_found",
      message: error.message,
    });
    return;
  }

  if (error instanceof ConflictError) {
    sendJson(res, 409, {
      error: "conflict",
      message: error.message,
      existingRunId:
        error.existingRunId ?? null,
    });
    return;
  }

  if (
    error instanceof
    ServiceUnavailableError
  ) {
    sendJson(res, 503, {
      error: "unavailable",
      message: error.message,
    });
    return;
  }

  console.error(
    "Unhandled Control Plane manager error:",
    error instanceof Error
      ? error.message
      : error,
  );

  sendJson(res, 500, {
    error: "internal_error",
    message: "Unexpected internal error.",
  });
}

function readJsonBody(
  req: IncomingMessage,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        reject(
          new ValidationError(
            "Request body too large.",
          ),
        );
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(
        chunks,
      ).toString("utf8");

      if (raw.trim() === "") {
        resolvePromise({});
        return;
      }

      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(
          new ValidationError(
            "Request body must be valid JSON.",
          ),
        );
      }
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function safePathname(
  url: string | undefined,
): string | null {
  try {
    return new URL(
      url ?? "/",
      "http://control-plane.local",
    ).pathname;
  } catch {
    return null;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Content-Length":
      Buffer.byteLength(body),
  });
  res.end(body);
}

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}
