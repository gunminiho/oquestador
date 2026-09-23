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
}

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class OpenHandsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionApiKey: string,
  ) {}

  async createConversation(
    options: CreateConversationOptions,
  ): Promise<ConversationInfo> {
    return this.request<ConversationInfo>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        workspace: {
          working_dir: options.workspace,
          kind: "LocalWorkspace",
        },
        agent_profile_id: options.agentProfileId,
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
      }),
    });
  }

  async getConversation(conversationId: string): Promise<ConversationInfo> {
    return this.request<ConversationInfo>(
      `/api/conversations/${conversationId}`,
    );
  }

  async waitUntilFinished(
    conversationId: string,
    options: WaitOptions = {},
  ): Promise<ConversationInfo> {
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 120_000;

    const startedAt = Date.now();

    let transient404Count = 0;
    let lastStatus = "unknown";

    while (true) {
      try {
        const conversation = await this.getConversation(conversationId);

        lastStatus = conversation.execution_status;

        if (conversation.execution_status === "finished") {
          return conversation;
        }
      } catch (error: unknown) {
        const isTransientNotFound =
          error instanceof Error &&
          error.message.includes("OpenHands API 404");

        if (!isTransientNotFound) {
          throw error;
        }

        transient404Count += 1;

        console.log(
          `Conversation ${conversationId} temporarily returned 404 ` +
            `(retry ${transient404Count}); continuing to poll...`,
        );
      }

      const elapsedMs = Date.now() - startedAt;

      if (elapsedMs >= timeoutMs) {
        throw new Error(
          `Conversation ${conversationId} timed out after ${timeoutMs}ms. ` +
            `Last status: ${lastStatus}. ` +
            `Transient 404s: ${transient404Count}.`,
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, pollIntervalMs),
      );
    }
  }
  async getFinalResponse(conversationId: string): Promise<string> {
    const result = await this.request<{ response: string }>(
      `/api/conversations/${conversationId}/agent_final_response`,
    );

    return result.response;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "X-Session-API-Key": this.sessionApiKey,
        "Content-Type": "application/json; charset=utf-8",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `OpenHands API ${response.status} ${response.statusText}: ${body}`,
      );
    }

    return (await response.json()) as T;
  }
}



