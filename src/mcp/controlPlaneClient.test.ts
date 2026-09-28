import test from "node:test";
import assert from "node:assert/strict";

import {
  ControlPlaneClient,
  ControlPlaneHttpError,
  ControlPlaneUnavailableError,
} from "./controlPlaneClient";

function jsonResponse(
  value: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(value),
    {
      status,
      headers: {
        "Content-Type":
          "application/json",
      },
    },
  );
}

test("ControlPlaneClient sends auth only as a header and maps run methods", async () => {
  const calls: {
    url: string;
    init: RequestInit;
  }[] = [];
  const client = new ControlPlaneClient({
    baseUrl: "http://control.local",
    token: "secret-token",
    fetchFn: (async (
      input,
      init,
    ) => {
      calls.push({
        url: String(input),
        init: init ?? {},
      });
      return jsonResponse({
        runs: [],
      });
    }) as typeof fetch,
  });

  await client.listRuns();

  assert.equal(
    calls[0]?.url,
    "http://control.local/api/runs",
  );
  assert.equal(
    (
      calls[0]?.init.headers as Record<
        string,
        string
      >
    ).Authorization,
    "Bearer secret-token",
  );
  assert.equal(
    calls[0]?.url.includes(
      "secret-token",
    ),
    false,
  );
});

test("ControlPlaneClient preserves 404 and 409 semantics", async () => {
  const statuses = [404, 409];

  for (const status of statuses) {
    const client =
      new ControlPlaneClient({
        baseUrl: "http://control.local",
        token: "secret-token",
        fetchFn: (async () =>
          jsonResponse(
            {
              error:
                status === 404
                  ? "not_found"
                  : "conflict",
              message:
                status === 404
                  ? "Run not found."
                  : "Invalid transition.",
              existingRunId:
                status === 409
                  ? "run-existing"
                  : undefined,
            },
            status,
          )) as typeof fetch,
      });

    await assert.rejects(
      client.getRun("run-a"),
      (
        error: unknown,
      ) =>
        error instanceof
          ControlPlaneHttpError &&
        error.status === status,
    );
  }
});

test("ControlPlaneClient reports unreachable Control Plane deterministically", async () => {
  const client = new ControlPlaneClient({
    baseUrl: "http://control.local",
    token: "secret-token",
    fetchFn: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });

  await assert.rejects(
    client.health(),
    ControlPlaneUnavailableError,
  );
});

test("ControlPlaneClient sanitizes token-shaped error text", async () => {
  const client = new ControlPlaneClient({
    baseUrl: "http://control.local",
    token: "secret-token",
    fetchFn: (async () =>
      jsonResponse(
        {
          error: "forbidden",
          message:
            "Authorization failed for Bearer secret-token",
        },
        403,
      )) as typeof fetch,
  });

  await assert.rejects(
    client.listTasks(),
    (
      error: unknown,
    ) =>
      error instanceof
        ControlPlaneHttpError &&
      !error.message.includes(
        "secret-token",
      ) &&
      error.message.includes(
        "[redacted]",
      ),
  );
});
