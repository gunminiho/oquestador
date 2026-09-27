export interface ConversationInfo {
  id: string;
  execution_status: string;
  created_at?: string;
  updated_at?: string;
}

export interface CreateConversationOptions {
  workspace: string;
  agentProfileId: string;
  message: string;
  conversationId?: string;
}

export interface WaitOptions {
  pollIntervalMs?: number;
}

export interface OpenHandsClientOptions {
  maxTransientRetries?: number;
  maxTransient404s?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  conversationSecretRefs?: string[];
  autoClaudeOauthSecretRef?: boolean;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class OpenHandsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenHandsApiError";
  }
}

export class OpenHandsTransientError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenHandsTransientError";
  }
}

export class ConversationTerminalError extends Error {
  constructor(
    public readonly conversationId: string,
    public readonly status: string,
  ) {
    super(
      `Conversation ${conversationId} ended with terminal status ${status}.`,
    );
    this.name = "ConversationTerminalError";
  }
}

const FINISHED_STATUS = "finished";

const TERMINAL_ERROR_STATUSES = new Set([
  "error",
  "stuck",
]);

const TRANSIENT_HTTP_STATUSES = new Set([
  502,
  503,
  504,
]);

const CLAUDE_CODE_OAUTH_TOKEN =
  "CLAUDE_CODE_OAUTH_TOKEN";

export class OpenHandsClient {
  private readonly maxTransientRetries: number;
  private readonly maxTransient404s: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly conversationSecretRefs: string[];
  private readonly autoClaudeOauthSecretRef: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (
    ms: number,
  ) => Promise<void>;
  private agentProfiles:
    | Promise<unknown[]>
    | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionApiKey: string,
    options: OpenHandsClientOptions = {},
  ) {
    this.maxTransientRetries =
      options.maxTransientRetries ?? 4;

    this.maxTransient404s =
      options.maxTransient404s ?? 20;

    this.baseBackoffMs =
      options.baseBackoffMs ?? 250;

    this.maxBackoffMs =
      options.maxBackoffMs ?? 4_000;

    this.conversationSecretRefs =
      normalizeConversationSecretRefs(
        options.conversationSecretRefs ??
          parseConversationSecretRefs(
            process.env
              .OH_CONVERSATION_SECRET_REFS,
          ),
      );

    this.autoClaudeOauthSecretRef =
      options.autoClaudeOauthSecretRef ?? true;

    this.fetchFn =
      options.fetchFn ?? fetch;

    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) =>
          setTimeout(resolve, ms),
        ));
  }

  async createConversation(
    options: CreateConversationOptions,
  ): Promise<ConversationInfo> {
    try {
      const body: Record<string, unknown> = {
        workspace: {
          working_dir: options.workspace,
          kind: "LocalWorkspace",
        },
        conversation_id:
          options.conversationId,
        agent_profile_id:
          options.agentProfileId,
        initial_message: {
          role: "user",
          content: [
            {
              type: "text",
              text: options.message,
            },
          ],
          run: true,
        },
        autotitle: false,
      };

      const conversationSecretRefs =
        await this
          .conversationSecretRefsForProfile(
            options.agentProfileId,
          );

      if (
        conversationSecretRefs.length >
        0
      ) {
        body.secrets =
          Object.fromEntries(
            conversationSecretRefs.map(
              (name) => [
                name,
                {
                  kind: "lookup",
                  url:
                    `/api/settings/secrets/${encodeURIComponent(name)}`,
                },
              ],
            ),
          );
      }

      return await this.request<ConversationInfo>(
        "/api/conversations",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        {
          retryable:
            options.conversationId !== undefined,
        },
      );
    } catch (error: unknown) {
      if (
        options.conversationId !== undefined &&
        error instanceof OpenHandsApiError &&
        error.status === 409
      ) {
        return {
          id: options.conversationId,
          execution_status: "running",
        };
      }

      throw error;
    }
  }

  async getConversation(
    conversationId: string,
  ): Promise<ConversationInfo> {
    return this.request<ConversationInfo>(
      `/api/conversations/${conversationId}`,
    );
  }

  async waitUntilFinished(
    conversationId: string,
    options: WaitOptions = {},
  ): Promise<ConversationInfo> {
    const pollIntervalMs =
      options.pollIntervalMs ?? 1000;

    let transient404Count = 0;
    let lastHeartbeatAt = Date.now();

    while (true) {
      try {
        const conversation =
          await this.getConversation(
            conversationId,
          );

        transient404Count = 0;

        if (
          conversation.execution_status ===
          FINISHED_STATUS
        ) {
          return conversation;
        }

        if (
          TERMINAL_ERROR_STATUSES.has(
            conversation.execution_status,
          )
        ) {
          throw new ConversationTerminalError(
            conversationId,
            conversation.execution_status,
          );
        }

        const now = Date.now();

        if (
          now - lastHeartbeatAt >=
          30_000
        ) {
          console.log(
            `Conversation ${conversationId} is still ${conversation.execution_status}; waiting...`,
          );

          lastHeartbeatAt = now;
        }
      } catch (error: unknown) {
        if (
          !(error instanceof OpenHandsApiError) ||
          error.status !== 404
        ) {
          throw error;
        }

        transient404Count += 1;

        if (
          transient404Count >
          this.maxTransient404s
        ) {
          throw new OpenHandsTransientError(
            `Conversation ${conversationId} exceeded ${this.maxTransient404s} transient 404 retries.`,
            {
              cause: error,
            },
          );
        }

        console.log(
          `Conversation ${conversationId} temporarily returned 404 ` +
            `(retry ${transient404Count}/${this.maxTransient404s}); continuing to poll...`,
        );
      }

      await this.sleep(
        pollIntervalMs,
      );
    }
  }

  async getFinalResponse(
    conversationId: string,
  ): Promise<string> {
    const result =
      await this.request<{
        response: string;
      }>(
        `/api/conversations/${conversationId}/agent_final_response`,
      );

    return result.response;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: {
      retryable?: boolean;
    } = {},
  ): Promise<T> {
    const retryable =
      options.retryable ?? true;

    let retryCount = 0;

    while (true) {
      let response: Response;

      try {
        response = await this.fetchFn(
          `${this.baseUrl}${path}`,
          {
            ...init,
            headers: {
              "X-Session-API-Key":
                this.sessionApiKey,
              "Content-Type":
                "application/json; charset=utf-8",
              ...init.headers,
            },
          },
        );
      } catch (error: unknown) {
        if (
          !retryable ||
          !isTransientNetworkError(error)
        ) {
          throw error;
        }

        if (
          retryCount >=
          this.maxTransientRetries
        ) {
          throw new OpenHandsTransientError(
            `OpenHands transport failed after ${retryCount + 1} attempts for ${path}.`,
            {
              cause:
                error instanceof Error
                  ? error
                  : undefined,
            },
          );
        }

        await this.backoff(
          retryCount,
        );

        retryCount += 1;
        continue;
      }

      if (!response.ok) {
        const body =
          await response.text();

        const apiError =
          new OpenHandsApiError(
            response.status,
            `OpenHands API ${response.status} ${response.statusText}: ${body}`,
          );

        if (
          retryable &&
          TRANSIENT_HTTP_STATUSES.has(
            response.status,
          )
        ) {
          if (
            retryCount >=
            this.maxTransientRetries
          ) {
            throw new OpenHandsTransientError(
              `OpenHands API ${response.status} remained unavailable after ${retryCount + 1} attempts for ${path}.`,
              {
                cause: apiError,
              },
            );
          }

          await this.backoff(
            retryCount,
          );

          retryCount += 1;
          continue;
        }

        throw apiError;
      }

      return (
        await response.json()
      ) as T;
    }
  }

  private async backoff(
    retryIndex: number,
  ): Promise<void> {
    const delay = Math.min(
      this.baseBackoffMs *
        2 ** retryIndex,
      this.maxBackoffMs,
    );

    await this.sleep(delay);
  }

  private async conversationSecretRefsForProfile(
    agentProfileId: string,
  ): Promise<string[]> {
    const refs = [
      ...this.conversationSecretRefs,
    ];

    if (
      this.autoClaudeOauthSecretRef &&
      !refs.includes(
        CLAUDE_CODE_OAUTH_TOKEN,
      ) &&
      (await this
        .isClaudeAcpAgentProfile(
          agentProfileId,
        ))
    ) {
      refs.push(
        CLAUDE_CODE_OAUTH_TOKEN,
      );
    }

    return refs;
  }

  private async isClaudeAcpAgentProfile(
    agentProfileId: string,
  ): Promise<boolean> {
    const profiles =
      await this.getAgentProfiles();

    const profile =
      profiles.find((candidate) =>
        profileMatchesId(
          candidate,
          agentProfileId,
        ),
      );

    return (
      profile !== undefined &&
      objectContainsClaudeAcpConfig(
        profile,
      )
    );
  }

  private async getAgentProfiles(): Promise<
    unknown[]
  > {
    this.agentProfiles ??=
      this.request<unknown>(
        "/api/agent-profiles",
      ).then(extractAgentProfiles);

    return this.agentProfiles;
  }
}

function parseConversationSecretRefs(
  value: string | undefined,
): string[] {
  if (!value) {
    return [];
  }

  return normalizeConversationSecretRefs(
    value.split(","),
  );
}

function normalizeConversationSecretRefs(
  refs: string[],
): string[] {
  const seen =
    new Set<string>();

  return refs
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(
          item,
        )
      ) {
        throw new Error(
          `Invalid OH_CONVERSATION_SECRET_REFS entry: ${item}`,
        );
      }

      if (seen.has(item)) {
        return false;
      }

      seen.add(item);
      return true;
    });
}

function extractAgentProfiles(
  payload: unknown,
): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    payload !== null &&
    typeof payload === "object"
  ) {
    const record =
      payload as Record<
        string,
        unknown
      >;

    for (const key of [
      "profiles",
      "agent_profiles",
      "items",
      "data",
    ]) {
      const value =
        record[key];

      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}

function profileMatchesId(
  profile: unknown,
  agentProfileId: string,
): boolean {
  if (
    profile === null ||
    typeof profile !== "object"
  ) {
    return false;
  }

  const record =
    profile as Record<
      string,
      unknown
    >;

  return (
    record.id === agentProfileId ||
    record.profile_id ===
      agentProfileId ||
    record.name === agentProfileId
  );
}

function objectContainsClaudeAcpConfig(
  value: unknown,
): boolean {
  const stack: unknown[] = [
    value,
  ];

  while (stack.length > 0) {
    const current =
      stack.pop();

    if (
      current === null ||
      typeof current !== "object"
    ) {
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    const record =
      current as Record<
        string,
        unknown
      >;

    if (
      record.acp_server ===
      "claude-code"
    ) {
      return true;
    }

    const command =
      record.acp_command;

    if (
      typeof command === "string" &&
      command.includes(
        "claude-agent-acp",
      )
    ) {
      return true;
    }

    if (
      Array.isArray(command) &&
      command.some(
        (item) =>
          typeof item ===
            "string" &&
          item.includes(
            "claude-agent-acp",
          ),
      )
    ) {
      return true;
    }

    stack.push(
      ...Object.values(record),
    );
  }

  return false;
}

function isTransientNetworkError(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause =
    (
      error as Error & {
        cause?: unknown;
      }
    ).cause;

  const causeText =
    cause instanceof Error
      ? cause.message
      : "";

  const text =
    `${error.name} ${error.message} ${causeText}`;

  return (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i.test(
      text,
    )
  );
}
