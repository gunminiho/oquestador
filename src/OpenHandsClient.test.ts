import test from "node:test";
import assert from "node:assert/strict";

import {
  ConversationTerminalError,
  OpenHandsApiError,
  OpenHandsClient,
  OpenHandsTransientError,
} from "./OpenHandsClient";

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

test(
  "retries 502 then succeeds",
  async () => {
    let calls = 0;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () => {
              calls += 1;

              return calls === 1
                ? new Response(
                    "bad",
                    {
                      status:
                        502,
                    },
                  )
                : jsonResponse({
                    id: "c",
                    execution_status:
                      "finished",
                  });
            }) as typeof fetch,
          sleep:
            async () => {},
          maxTransientRetries:
            2,
        },
      );

    const result =
      await client
        .getConversation("c");

    assert.equal(
      result.execution_status,
      "finished",
    );

    assert.equal(
      result.execution_status,
      "running",
    );

    assert.equal(
      calls,
      1,
    );
  },
);

test(
  "retries ECONNRESET then succeeds",
  async () => {
    let calls = 0;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () => {
              calls += 1;

              if (
                calls === 1
              ) {
                throw new Error(
                  "read ECONNRESET",
                );
              }

              return jsonResponse({
                id: "c",
                execution_status:
                  "finished",
              });
            }) as typeof fetch,
          sleep:
            async () => {},
          maxTransientRetries:
            2,
        },
      );

    await client
      .getConversation("c");

    assert.equal(
      calls,
      2,
    );
  },
);

test(
  "exhausted transient retries are explicit",
  async () => {
    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () =>
              new Response(
                "bad",
                {
                  status: 503,
                },
              )) as typeof fetch,
          sleep:
            async () => {},
          maxTransientRetries:
            1,
        },
      );

    await assert.rejects(
      client.getConversation(
        "c",
      ),
      OpenHandsTransientError,
    );
  },
);

test(
  "non transient 4xx is not retried",
  async () => {
    let calls = 0;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () => {
              calls += 1;

              return new Response(
                "no",
                {
                  status: 401,
                },
              );
            }) as typeof fetch,
          sleep:
            async () => {},
          maxTransientRetries:
            4,
        },
      );

    await assert.rejects(
      client.getConversation(
        "c",
      ),
      (
        error: unknown,
      ) =>
        error instanceof
          OpenHandsApiError &&
        error.status === 401,
    );

    assert.equal(
      calls,
      1,
    );
  },
);

test(
  "terminal status remains terminal",
  async () => {
    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () =>
              jsonResponse({
                id: "c",
                execution_status:
                  "error",
              })) as typeof fetch,
          sleep:
            async () => {},
        },
      );

    await assert.rejects(
      client.waitUntilFinished(
        "c",
        {
          pollIntervalMs: 0,
        },
      ),
      ConversationTerminalError,
    );
  },
);

test(
  "transient 404 polling is bounded and can recover",
  async () => {
    let calls = 0;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () => {
              calls += 1;

              return calls === 1
                ? new Response(
                    "missing",
                    {
                      status:
                        404,
                    },
                  )
                : jsonResponse({
                    id: "c",
                    execution_status:
                      "finished",
                  });
            }) as typeof fetch,
          sleep:
            async () => {},
          maxTransient404s:
            2,
        },
      );

    const result =
      await client
        .waitUntilFinished(
          "c",
          {
            pollIntervalMs: 0,
          },
        );

    assert.equal(
      result.execution_status,
      "finished",
    );
  },
);


test(
  "transient 404 polling fails after its bounded retry budget",
  async () => {
    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async () =>
              new Response(
                "missing",
                {
                  status: 404,
                },
              )) as typeof fetch,
          sleep:
            async () => {},
          maxTransient404s:
            1,
        },
      );

    await assert.rejects(
      client.waitUntilFinished(
        "c",
        {
          pollIntervalMs: 0,
        },
      ),
      OpenHandsTransientError,
    );
  },
);

test(
  "deterministic conversation creation recovers from a 409 without a racy follow-up lookup",
  async () => {
    let calls = 0;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          fetchFn:
            (async (
              _input,
              init,
            ) => {
              calls += 1;

              if (
                init?.method ===
                "POST"
              ) {
                return new Response(
                  "already exists",
                  {
                    status: 409,
                  },
                );
              }

              return jsonResponse({
                id: "fixed-id",
                execution_status:
                  "running",
              });
            }) as typeof fetch,
          sleep:
            async () => {},
        },
      );

    const result =
      await client
        .createConversation({
          workspace:
            "/projects/task",
          agentProfileId:
            "profile",
          message:
            "hello",
          conversationId:
            "fixed-id",
        });

    assert.equal(
      result.id,
      "fixed-id",
    );
    assert.equal(
      calls,
      2,
    );
  },
);
