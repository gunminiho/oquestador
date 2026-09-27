# Claude ACP authentication root cause

Task: `claude-acp-auth-root-cause-v2`

Date: 2026-09-27

PR: `#8`

Reviewed starting SHA: `6fdc4d4f7c4a418d708bd03f367541afbb978f9f`

## Cause Root

The `claude-acp-effort-fix-v5` conversation failed because the orchestrator created the Agent Canvas conversation with only `agent_profile_id`. OpenHands resolves that profile into a Claude ACP agent, but it does not automatically copy global custom secrets from `~/.openhands/secrets.json` into `StartConversationRequest.secrets`.

The exact boundary is the conversation create request from this repository. Before this fix, `OpenHandsClient.createConversation()` sent `agent_profile_id` and no `secrets`. In OpenHands SDK 1.49.4, the Claude ACP subprocess environment is built from `default_environment`, `os.environ`, and `state.secret_registry`; since the request did not seed `state.secret_registry` with `CLAUDE_CODE_OAUTH_TOKEN`, the child could start and create an ACP session, but the first model prompt returned `ACPAuthRequired` / `[-32000] Authentication required`.

This was not a repeat of the model+effort issue. The failing conversation used `acp_model="opus[1m]"`, `acp_current_model_id="opus[1m]"`, and reached `@agentclientprotocol/claude-agent-acp` 0.63.0 before failing with prompt/completion tokens at zero.

## Evidence

Confirmed initial/runtime facts:

- Agent Canvas 1.22.0, `openhands-sdk==1.49.4`, and `claude-agent-acp` 0.63.0 are the relevant versions for this investigation.
- The failed conversation `65b89aa5-4d28-5dbd-9f77-e4f2b1ddfed1` ended in `execution_status="error"` with `ConversationErrorEvent code="ACPAuthRequired"` and `detail="[-32000] Authentication required"`.
- Its state showed `@agentclientprotocol/claude-agent-acp` version `0.63.0`, `acp_model_via_config_option=true`, `acp_current_model_id="opus[1m]"`, and `acp_model="opus[1m]"`.
- The conversation profile was Claude: `acp_server="claude-code"`, `acp_command=["claude-agent-acp"]`, `acp_session_mode="bypassPermissions"`.
- The launched profile had `secret_refs=null`; the create request metadata had `secrets={}`.
- The local persisted secret store decrypts in memory and contains `CLAUDE_CODE_OAUTH_TOKEN` but not `ANTHROPIC_API_KEY`. Values were not printed.

OpenHands SDK 1.49.4 code evidence:

- `ACP_PROVIDERS["claude-code"]` declares `api_key_env_var="ANTHROPIC_API_KEY"` and `env_conflicts=[("CLAUDE_CODE_OAUTH_TOKEN", ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"))]`.
- `_start_acp_server()` builds env in this order: `default_environment()`, `os.environ`, then `state.secret_registry.get_all_secrets_as_env_vars(...)`; after that it removes `CLAUDECODE` and calls `_strip_conflicting_env(env)`.
- A sanitized child-process probe through `ACPAgent._start_acp_server()` with both synthetic Claude credentials in `secret_registry` produced:

```json
{
  "CLAUDE_CODE_OAUTH_TOKEN": true,
  "ANTHROPIC_API_KEY": false,
  "ANTHROPIC_BASE_URL": false,
  "CLAUDECODE": false
}
```

This proves that when `CLAUDE_CODE_OAUTH_TOKEN` is present in the conversation registry, it reaches the child process and intentionally strips `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`.

Provider probes:

- OAuth-only direct Claude Code probe during the original investigation used the decrypted local `CLAUDE_CODE_OAUTH_TOKEN` in memory and `HOME` pointed to a temporary directory. Command class: Claude binary `--print`, model `haiku`, max budget `0.02`.
- Original result: exit code `0`, stdout nonempty, sanitized tail `ok`.
- Follow-up OpenHands SDK + Claude ACP smoke after reviewer feedback used the same secret source through a `LookupSecret` path and a local in-process resolver. The Claude ACP child started as `@agentclientprotocol/claude-agent-acp` 0.63.0, received the secret, and the provider returned `[-32603] Internal error: Failed to authenticate. API Error: 401 Invalid bearer token: {"errorKind": "authentication_failed"}`.
- This proves the repository boundary fix delivers the OAuth credential into the Claude ACP route, and it also proves the OAuth credential available at follow-up time is no longer accepted by Claude Code. That final credential state is external to this repository and must be fixed by renewing/replacing the Claude OAuth credential in the Agent Canvas/OpenHands secret store.
- API-key-only direct probe could not be performed here because the readable local secret store and process environment did not contain `ANTHROPIC_API_KEY`. The task statement confirms it exists in the main container; Docker was not available in this workspace to inspect that container (`/var/run/docker.sock` absent).

## Fix

`OpenHandsClient` now adds the Claude OAuth Agent Canvas lookup directly to the create request for detected Claude profiles, without reading `/api/agent-profiles` or any other backend preflight endpoint:

```json
{
  "secrets": {
    "CLAUDE_CODE_OAUTH_TOKEN": {
      "kind": "LookupSecret",
      "url": "/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN"
    }
  }
}
```

Agent Canvas resolves that lookup server-side from its secret store. The orchestrator never reads, logs, copies, or persists the secret value.

This connects the secret to the real orchestrator flow without requiring a new externally configured `OH_CONVERSATION_SECRET_REFS` variable and without depending on `/api/agent-profiles`, which is not available to this workspace's session key. The automatic OAuth lookup is scoped to known Claude profile ids/names from `OH_CLAUDE_AGENT_PROFILE_IDS` and the local `~/.openhands/agent-profiles/claude.json`; other profiles do not receive the default Claude OAuth lookup. `OH_CONVERSATION_SECRET_REFS` remains available for explicit extra lookups, and callers can disable the default Claude lookup with `autoClaudeOauthSecretRef: false`.

## Hypotheses

- OAuth token invalid, expired, or revoked: originally ruled out by a direct Claude Code smoke returning `ok`; no longer ruled out after reviewer feedback. The follow-up OpenHands SDK + Claude ACP smoke received a provider `401 Invalid bearer token`, so the current available OAuth credential is invalid, expired, revoked, or otherwise not accepted by Claude Code.
- OpenHands strips OAuth before launching the child: ruled out by the child-process env probe; OAuth reaches the child when registered.
- API key should override OAuth when both exist: ruled out by OpenHands provider configuration; OAuth is dominant and strips API key/base URL before the child starts.
- Model+effort caused this auth failure: ruled out by the failing auth conversation state; model was already `opus[1m]`, and the terminal error was `ACPAuthRequired`, not `model_not_found`.
- Whether the inaccessible main container also had `ANTHROPIC_API_KEY`: accepted as a task-provided confirmed fact, but UNPROVEN from this workspace because Docker/backend access was unavailable.

## Commands And Sanitized Results

- `git status -sb`: detached HEAD in isolated worktree, clean before edits.
- OpenHands package inspection: `openhands-sdk 1.49.4`, `acp_agent.py` under `/usr/local/lib/python3.13/site-packages/openhands/sdk/agent/acp_agent.py`.
- Claude profile inspection: `~/.openhands/agent-profiles/claude.json` showed Claude ACP settings and `secret_refs=null`; no secrets printed.
- Failed conversation inspection: `base_state.json` and events for `65b89aa54d285dbd9f77e4f2b1ddfed1` showed `ACPAuthRequired`, `claude-agent-acp` 0.63.0, and model `opus[1m]`.
- Secret store presence probe: `CLAUDE_CODE_OAUTH_TOKEN=present`, `ANTHROPIC_API_KEY=absent`, values not printed.
- ACP child env probe: `CLAUDE_CODE_OAUTH_TOKEN=true`, `ANTHROPIC_API_KEY=false`.
- Direct OAuth smoke: Claude Code returned `ok`.
- Request-boundary regression test: `createConversation()` sends `secrets.CLAUDE_CODE_OAUTH_TOKEN={kind:"LookupSecret",url:"/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN"}` for a detected Claude profile without passing `conversationSecretRefs` manually and without calling `/api/agent-profiles`.
- Scope/opt-out guard tests: non-Claude profiles do not receive the default Claude OAuth lookup while the default `autoClaudeOauthSecretRef` behavior remains active, and `autoClaudeOauthSecretRef:false` creates a Claude-profile conversation without a `secrets` field.
- Local checks after the fix: `npm test` and `npm run typecheck` passed.
- Local backend access check after the reviewer feedback: `/api/conversations/search`, `/api/settings`, and `/api/agent-profiles` each returned HTTP 403 with the available session key.
- OpenHands SDK contract test after reviewer feedback: the generated create payload validates against `StartConversationRequest` from installed `openhands-sdk==1.49.4`, and the secret source deserializes as `LookupSecret`. The previous `kind:"lookup"` shape is rejected by that model and was corrected in this commit.
- Corrected Agent Canvas smoke attempt: direct `POST /api/conversations` with the sanitized `LookupSecret` request returned HTTP 405 in this workspace before a conversation was created.
- OpenHands SDK + Claude ACP smoke after reviewer feedback: a local `Conversation` using `ACPAgent(acp_command=["claude-agent-acp"], acp_server="claude-code", acp_session_mode="bypassPermissions", acp_model="haiku")` and `secrets={"CLAUDE_CODE_OAUTH_TOKEN": LookupSecret(url="/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN")}` started `claude-agent-acp` 0.63.0, resolved the secret through the same `LookupSecret` path, and failed at provider authentication with sanitized result `401 Invalid bearer token`; no assistant response was produced.
- Docker availability: Docker CLI exists, but daemon socket was unavailable, so no Docker image build or main-container inspection was performed.

## Smoke Status

Direct Claude Code OAuth smoke passed during the original investigation and did not show `ACPAuthRequired`.

A full Agent Canvas conversation smoke through the backend remains UNPROVEN in this workspace because the available API key returned 403 from read endpoints and the corrected create request returned 405 before conversation creation. Docker was also unavailable, so the main runtime container could not be inspected or restarted from here.

The follow-up OpenHands SDK + Claude ACP smoke did exercise the fixed secret boundary through `LookupSecret` and the installed ACP stack. It no longer failed because the repository omitted `StartConversationRequest.secrets`; it failed because Claude Code rejected the delivered OAuth credential with `401 Invalid bearer token`. A successful end-to-end Agent Canvas Claude response now requires renewing/replacing `CLAUDE_CODE_OAUTH_TOKEN` in the OpenHands/Agent Canvas secret store. No repository workaround should mask that credential failure.
