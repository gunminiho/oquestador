import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  claudeAgentProfileIds?: string[];
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
  private readonly claudeAgentProfileIds: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (
    ms: number,
  ) => Promise<void>;

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

    this.autoClaudeOauthSecretRef =
      options.autoClaudeOauthSecretRef ??
      true;

    this.claudeAgentProfileIds =
      getClaudeAgentProfileIds(
        options.claudeAgentProfileIds,
      );

    this.conversationSecretRefs =
      normalizeConversationSecretRefs(
        [
          ...(options.conversationSecretRefs ??
            parseConversationSecretRefs(
              process.env
                .OH_CONVERSATION_SECRET_REFS,
            )),
        ],
      );

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

      const secretRefs =
        this.conversationSecretRefs.slice();

      if (
        this.autoClaudeOauthSecretRef &&
        this.isClaudeAgentProfile(
          options.agentProfileId,
        )
      ) {
        secretRefs.unshift(
          CLAUDE_CODE_OAUTH_TOKEN,
        );
      }

      const normalizedSecretRefs =
        normalizeConversationSecretRefs(
          secretRefs,
        );

      if (normalizedSecretRefs.length > 0) {
        body.secrets =
          Object.fromEntries(
            normalizedSecretRefs
              .map((name) => [
                name,
                {
                  kind: "LookupSecret",
                  url:
                    `/api/settings/secrets/${encodeURIComponent(name)}`,
                },
              ]),
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

  private isClaudeAgentProfile(
    agentProfileId: string,
  ): boolean {
    return this.claudeAgentProfileIds.has(
      agentProfileId,
    );
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
          !isTransientConversationStateError(
            error,
          )
        ) {
          throw error;
        }

        transient404Count += 1;

        if (
          transient404Count >
          this.maxTransient404s
        ) {
          throw new OpenHandsTransientError(
            `Conversation ${conversationId} exceeded ${this.maxTransient404s} transient conversation-state retries.`,
            {
              cause: error,
            },
          );
        }

        console.log(
          `Conversation ${conversationId} temporarily returned an incomplete conversation state ` +
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

}

function getClaudeAgentProfileIds(
  configuredIds:
    | string[]
    | undefined,
): Set<string> {
  return new Set(
    normalizeList(
      [
        ...(configuredIds ??
          parseList(
            process.env
              .OH_CLAUDE_AGENT_PROFILE_IDS,
          )),
        ...readLocalClaudeAgentProfileIds(),
      ],
    ),
  );
}

function parseList(
  value: string | undefined,
): string[] {
  return normalizeList(
    value?.split(",") ?? [],
  );
}

function normalizeList(
  values: Array<string | undefined>,
): string[] {
  const seen =
    new Set<string>();

  return values
    .filter(
      (item): item is string =>
        typeof item === "string",
    )
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }

      seen.add(item);
      return true;
    });
}

function readLocalClaudeAgentProfileIds(): string[] {
  try {
    const profile = JSON.parse(
      readFileSync(
        join(
          homedir(),
          ".openhands",
          "agent-profiles",
          "claude.json",
        ),
        "utf8",
      ),
    ) as unknown;

    if (
      typeof profile !== "object" ||
      profile === null
    ) {
      return [];
    }

    const record =
      profile as Record<string, unknown>;

    return [
      record.id,
      record.name,
    ].filter(
      (value): value is string =>
        typeof value === "string" &&
        value.length > 0,
    );
  } catch {
    return [];
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

function isTransientConversationStateError(
  error: unknown,
): boolean {
  if (
    !(error instanceof OpenHandsApiError)
  ) {
    return false;
  }

  if (error.status === 404) {
    return true;
  }

  return (
    error.status === 500 &&
    error.message.includes(
      "No such file or directory",
    ) &&
    error.message.includes(
      "/agent-canvas/conversations/",
    ) &&
    error.message.includes(
      "/base_state.json",
    )
  );
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
