import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      calls,
      2,
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
    let postCalls = 0;

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
              if (
                init?.method ===
                "POST"
              ) {
                postCalls += 1;

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
      result.execution_status,
      "running",
    );

    assert.equal(
      postCalls,
      1,
    );
  },
);

test(
  "createConversation can include lookup secret references without values",
  async () => {
    let capturedBody:
      | Record<string, unknown>
      | undefined;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          autoClaudeOauthSecretRef:
            false,
          conversationSecretRefs: [
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
          ],
          fetchFn:
            (async (
              _input,
              init,
            ) => {
              capturedBody =
                JSON.parse(
                  String(init?.body),
                ) as Record<
                  string,
                  unknown
                >;

              return jsonResponse({
                id: "c",
                execution_status:
                  "running",
              });
            }) as typeof fetch,
        },
      );

    await client
      .createConversation({
        workspace:
          "/projects/task",
        agentProfileId:
          "profile",
        message:
          "hello",
      });

    assert.deepEqual(
      capturedBody?.secrets,
      {
        CLAUDE_CODE_OAUTH_TOKEN: {
          kind: "LookupSecret",
          url:
            "/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN",
        },
      },
    );
  },
);

test(
  "createConversation includes Claude OAuth lookup without profile preflight",
  async () => {
    const paths: string[] = [];
    let capturedBody:
      | Record<string, unknown>
      | undefined;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          claudeAgentProfileIds: [
            "claude-profile",
          ],
          fetchFn:
            (async (
              input,
              init,
            ) => {
              const path =
                new URL(
                  String(input),
                ).pathname;
              paths.push(path);

              capturedBody =
                JSON.parse(
                  String(init?.body),
                ) as Record<
                  string,
                  unknown
                >;

              return jsonResponse({
                id: "c",
                execution_status:
                  "running",
              });
            }) as typeof fetch,
        },
      );

    await client
      .createConversation({
        workspace:
          "/projects/task",
        agentProfileId:
          "claude-profile",
        message:
          "hello",
      });

    assert.deepEqual(
      paths,
      [
        "/api/conversations",
      ],
    );

    assert.deepEqual(
      capturedBody?.secrets,
      {
        CLAUDE_CODE_OAUTH_TOKEN: {
          kind: "LookupSecret",
          url:
            "/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN",
        },
      },
    );
  },
);

test(
  "createConversation detects the local Claude profile used by the orchestrator",
  async () => {
    const previousHome =
      process.env.HOME;
    const previousProfileIds =
      process.env
        .OH_CLAUDE_AGENT_PROFILE_IDS;
    const previousSecretRefs =
      process.env
        .OH_CONVERSATION_SECRET_REFS;

    const home =
      mkdtempSync(
        join(
          tmpdir(),
          "openhands-client-home-",
        ),
      );
    const profileDir =
      join(
        home,
        ".openhands",
        "agent-profiles",
      );
    mkdirSync(profileDir, {
      recursive: true,
    });

    const claudeProfileId =
      "6dfd17c3-07dc-41f1-b4aa-8c02fcafb5ec";

    writeFileSync(
      join(
        profileDir,
        "claude.json",
      ),
      JSON.stringify({
        id: claudeProfileId,
        name: "claude",
        agent_kind: "acp",
        secret_refs: null,
        agent_settings: {
          acp_server:
            "claude-code",
          acp_command: [
            "claude-agent-acp",
          ],
        },
      }),
    );

    let capturedBody:
      | Record<string, unknown>
      | undefined;

    try {
      process.env.HOME = home;
      delete process.env
        .OH_CLAUDE_AGENT_PROFILE_IDS;
      delete process.env
        .OH_CONVERSATION_SECRET_REFS;

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
                capturedBody =
                  JSON.parse(
                    String(init?.body),
                  ) as Record<
                    string,
                    unknown
                  >;

                return jsonResponse({
                  id: "c",
                  execution_status:
                    "running",
                });
              }) as typeof fetch,
          },
        );

      await client
        .createConversation({
          workspace:
            "/projects/task",
          agentProfileId:
            claudeProfileId,
          message:
            "hello",
        });
    } finally {
      if (
        previousHome === undefined
      ) {
        delete process.env.HOME;
      } else {
        process.env.HOME =
          previousHome;
      }

      if (
        previousProfileIds ===
        undefined
      ) {
        delete process.env
          .OH_CLAUDE_AGENT_PROFILE_IDS;
      } else {
        process.env
          .OH_CLAUDE_AGENT_PROFILE_IDS =
          previousProfileIds;
      }

      if (
        previousSecretRefs ===
        undefined
      ) {
        delete process.env
          .OH_CONVERSATION_SECRET_REFS;
      } else {
        process.env
          .OH_CONVERSATION_SECRET_REFS =
          previousSecretRefs;
      }
    }

    assert.deepEqual(
      capturedBody?.secrets,
      {
        CLAUDE_CODE_OAUTH_TOKEN: {
          kind: "LookupSecret",
          url:
            "/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN",
        },
      },
    );
  },
);

test(
  "createConversation does not include default Claude OAuth lookup for other profiles",
  async () => {
    const paths: string[] = [];
    let capturedBody:
      | Record<string, unknown>
      | undefined;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          claudeAgentProfileIds: [
            "claude-profile",
          ],
          fetchFn:
            (async (
              input,
              init,
            ) => {
              const path =
                new URL(
                  String(input),
                ).pathname;
              paths.push(path);

              capturedBody =
                JSON.parse(
                  String(init?.body),
                ) as Record<
                  string,
                  unknown
                >;

              return jsonResponse({
                id: "c",
                execution_status:
                  "running",
              });
            }) as typeof fetch,
        },
      );

    await client
      .createConversation({
        workspace:
          "/projects/task",
        agentProfileId:
          "profile",
        message:
          "hello",
      });

    assert.deepEqual(
      paths,
      [
        "/api/conversations",
      ],
    );

    assert.equal(
      "secrets" in
        (capturedBody ?? {}),
      false,
    );
  },
);

test(
  "createConversation can disable the default Claude OAuth lookup",
  async () => {
    let capturedBody:
      | Record<string, unknown>
      | undefined;

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          autoClaudeOauthSecretRef:
            false,
          claudeAgentProfileIds: [
            "claude-profile",
          ],
          fetchFn:
            (async (
              _input,
              init,
            ) => {
              capturedBody =
                JSON.parse(
                  String(init?.body),
                ) as Record<
                  string,
                  unknown
                >;

              return jsonResponse({
                id: "c",
                execution_status:
                  "running",
              });
            }) as typeof fetch,
        },
      );

    await client
      .createConversation({
        workspace:
          "/projects/task",
        agentProfileId:
          "claude-profile",
        message:
          "hello",
      });

    assert.equal(
      "secrets" in
        (capturedBody ?? {}),
      false,
    );
  },
);

test(
  "Claude OAuth lookup payload validates against OpenHands SDK 1.49.4",
  async () => {
    let capturedBody:
      | Record<string, unknown>
      | undefined;

    const claudeProfileId =
      "6dfd17c3-07dc-41f1-b4aa-8c02fcafb5ec";

    const client =
      new OpenHandsClient(
        "http://test",
        "key",
        {
          claudeAgentProfileIds: [
            claudeProfileId,
          ],
          fetchFn:
            (async (
              _input,
              init,
            ) => {
              capturedBody =
                JSON.parse(
                  String(init?.body),
                ) as Record<
                  string,
                  unknown
                >;

              return jsonResponse({
                id: "c",
                execution_status:
                  "running",
              });
            }) as typeof fetch,
        },
      );

    await client
      .createConversation({
        workspace:
          "/projects/task",
        agentProfileId:
          claudeProfileId,
        message:
          "hello",
      });

    const output = execFileSync(
      "python",
      [
        "-c",
        [
          "import json, sys",
          "from openhands.sdk.conversation.request import StartConversationRequest",
          "payload = json.load(sys.stdin)",
          "request = StartConversationRequest.model_validate(payload)",
          "print(type(request.secrets['CLAUDE_CODE_OAUTH_TOKEN']).__name__)",
        ].join("; "),
      ],
      {
        input: JSON.stringify(
          capturedBody,
        ),
        env: {
          ...process.env,
          OPENHANDS_SUPPRESS_BANNER:
            "1",
        },
        encoding: "utf8",
      },
    ).trim();

    assert.equal(
      output,
      "LookupSecret",
    );
  },
);

test(
  "invalid configured secret references are rejected",
  async () => {
    assert.throws(
      () =>
        new OpenHandsClient(
          "http://test",
          "key",
          {
            conversationSecretRefs: [
              "../CLAUDE_CODE_OAUTH_TOKEN",
            ],
          },
        ),
      /Invalid OH_CONVERSATION_SECRET_REFS entry/,
    );
  },
);
