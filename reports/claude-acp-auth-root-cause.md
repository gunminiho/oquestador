# Claude ACP authentication root cause

Task: `claude-acp-auth-root-cause-v2`

Date: 2026-09-27

PR: `#8`

Reviewed starting SHA for this correction pass: `25bbc0d4d6a93f56fbf07293e91a4df71ec8d96d`

## Cause Root

The original `claude-acp-effort-fix-v5` failure was caused at this repository's Agent Canvas conversation-create boundary. The orchestrator created the conversation with `agent_profile_id` only. The resolved Claude profile had `secret_refs=null`, and the create request did not include `StartConversationRequest.secrets`, so the conversation secret registry was not seeded with `CLAUDE_CODE_OAUTH_TOKEN`.

In `openhands-sdk==1.49.4`, Claude ACP builds the child environment from `default_environment()`, `os.environ`, and then `state.secret_registry`. The SDK strips `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` when `CLAUDE_CODE_OAUTH_TOKEN` is present, because OAuth is declared as the dominant credential. If the OAuth token is not present in `state.secret_registry` or the child environment, `claude-agent-acp` can still start, but the first useful provider request fails with `ACPAuthRequired` / `[-32000] Authentication required`.

This is separate from the previous model+effort investigation. The failed conversation already reached `@agentclientprotocol/claude-agent-acp` 0.63.0, showed `acp_model="opus[1m]"`, `acp_current_model_id="opus[1m]"`, and ended before any useful model response with `prompt_tokens=0` and `completion_tokens=0`.

The current credential state is a separate external blocker. A follow-up SDK+ACP smoke after the repository fix proved the fixed path delivers a `CLAUDE_CODE_OAUTH_TOKEN` into the Claude ACP route, but Claude Code then rejected the value resolved through that path with `401 Invalid bearer token`. An earlier direct Claude Code OAuth probe had succeeded with an in-memory token available during that investigation; that result does not prove the later `LookupSecret`-resolved value remained valid or identical. In this follow-up workspace the Claude credentials are absent from `process.env`, and the local Agent Canvas backend returns HTTP 403 for settings/profile APIs with the available session key, so the current plaintext OAuth/API-key values cannot be re-read or compared safely here.

## Evidence

Confirmed initial/runtime facts:

- Agent Canvas 1.22.0, `openhands-sdk==1.49.4`, and `claude-agent-acp` 0.63.0 are the relevant versions.
- Conversation `65b89aa5-4d28-5dbd-9f77-e4f2b1ddfed1` ended in `execution_status="error"` with `ConversationErrorEvent code="ACPAuthRequired"` and `detail="[-32000] Authentication required"`.
- That conversation had `runtime_status="available"`, `can_resume=true`, `runtime_error=null`, and started `@agentclientprotocol/claude-agent-acp` 0.63.0.
- Its Claude ACP state showed `acp_server="claude-code"`, `acp_command=["claude-agent-acp"]`, `acp_session_mode="bypassPermissions"`, `acp_current_model_id="opus[1m]"`, `acp_model="opus[1m]"`, and `reasoning_effort="high"`.
- The profile state had `secret_refs=null`; the create request metadata had `secrets={}`.
- The readable local OpenHands secret store decrypted in memory and contained `CLAUDE_CODE_OAUTH_TOKEN`; no secret values were printed, copied, or persisted.

OpenHands SDK 1.49.4 code evidence:

- `ACP_PROVIDERS["claude-code"]` declares `api_key_env_var="ANTHROPIC_API_KEY"` and `env_conflicts=[("CLAUDE_CODE_OAUTH_TOKEN", ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"))]`.
- `_start_acp_server()` builds env in this order: `default_environment()`, `os.environ`, then `state.secret_registry.get_all_secrets_as_env_vars(...)`; after that it removes `CLAUDECODE` and calls `_strip_conflicting_env(env)`.
- A sanitized child-process probe through `ACPAgent._start_acp_server()` with synthetic Claude credentials in `secret_registry` produced:

```json
{
  "CLAUDE_CODE_OAUTH_TOKEN": true,
  "ANTHROPIC_API_KEY": false,
  "ANTHROPIC_BASE_URL": false,
  "CLAUDECODE": false
}
```

This proves that when `CLAUDE_CODE_OAUTH_TOKEN` is present in the conversation registry, it reaches the child process and intentionally strips API-key fallback variables.

Credential/provenance evidence:

- The Claude profile file exists at `~/.openhands/agent-profiles/claude.json`, has a UUID `id`, name `claude`, `agent_kind="acp"`, and `secret_refs=null`; sanitized inspection did not print credentials.
- The orchestrator passes `OH_AGENT_PROFILE_ID` directly into `runWorkflow()` and `OpenHandsClient.createConversation()`, but that variable only names the active profile and does not prove the profile is Claude. The corrected fix no longer treats `OH_AGENT_PROFILE_ID` alone as a Claude signal.
- A new regression test reproduces that production path: `OpenHandsClient` is constructed without options, `$HOME/.openhands/agent-profiles/claude.json` contains the Claude profile id, and `createConversation()` sends `secrets.CLAUDE_CODE_OAUTH_TOKEN={kind:"LookupSecret",url:"/api/settings/secrets/CLAUDE_CODE_OAUTH_TOKEN"}` for that profile.
- A second regression test covers the reviewer-requested boundary: only `OH_AGENT_PROFILE_ID` is configured, `OH_CLAUDE_AGENT_PROFILE_IDS` and `OH_CONVERSATION_SECRET_REFS` are unset, `$HOME` has no local OpenHands profile file, and `createConversation()` does not send `CLAUDE_CODE_OAUTH_TOKEN`.
- `StartConversationRequest` from installed `openhands-sdk==1.49.4` validates the generated request shape when `agent_profile_id` is a UUID, and deserializes the secret source as `openhands.sdk.secret.secrets.LookupSecret`.
- Local Agent Canvas API access using the available session key returned HTTP 403 for `/api/settings` in this follow-up workspace, so the backend could not be used here to inspect encrypted settings or create a full smoke conversation.

Provider probes:

- Original OAuth-only direct Claude Code probe used the decrypted local `CLAUDE_CODE_OAUTH_TOKEN` in memory, a temporary `HOME`, Claude binary `--print`, model `haiku`, and a small max budget. It exited `0` with sanitized output tail `ok`, so the credential accepted direct Claude Code at that time.
- Follow-up OpenHands SDK+Claude ACP smoke used the fixed `LookupSecret` path with a local in-process resolver. The child started `@agentclientprotocol/claude-agent-acp` 0.63.0, received the OAuth secret, and then failed at the provider boundary with sanitized result `[-32603] Internal error: Failed to authenticate. API Error: 401 Invalid bearer token: {"errorKind": "authentication_failed"}`. This proves the repository boundary was no longer dropping OAuth; it does not prove why the later resolved credential differed from, or aged differently than, the earlier direct-probe credential.
- API-key-only direct probe could not be performed from this follow-up workspace because the readable local process environment did not contain `ANTHROPIC_API_KEY`, and Agent Canvas settings/secret APIs returned HTTP 403 with the available session key. The task-provided fact that `ANTHROPIC_API_KEY` exists in the main container is accepted, but Docker/backend access was not available here to inspect that container safely.

## Fix

`OpenHandsClient.createConversation()` now attaches Agent Canvas lookup secret refs to the conversation request without ever reading secret values:

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

The default Claude OAuth lookup is added only when the requested `agentProfileId` matches a configured Claude profile id/name from `OH_CLAUDE_AGENT_PROFILE_IDS` or the local `~/.openhands/agent-profiles/claude.json`. `OH_AGENT_PROFILE_ID` is intentionally not used as an implicit Claude signal because it can name any active profile. Deployments whose Claude profile file is not available to this client process must set `OH_CLAUDE_AGENT_PROFILE_IDS` explicitly.

`OH_CONVERSATION_SECRET_REFS` remains available for explicit extra lookup refs. `autoClaudeOauthSecretRef:false` is available for tests or deployments that intentionally do not want the default Claude OAuth lookup.

No token, API key, Authorization header, cookie, or full auth file was printed, copied into the repo, or committed.

## Hypotheses

Demonstrated:

- Original repository boundary was missing `StartConversationRequest.secrets` for the Claude conversation.
- Treating every `OH_AGENT_PROFILE_ID` value as Claude would expose `CLAUDE_CODE_OAUTH_TOKEN` to non-Claude profiles; this has been removed.
- OpenHands SDK 1.49.4 strips API key/base URL when OAuth is present, so OAuth has precedence over API-key fallback.
- When OAuth is seeded into `state.secret_registry`, it reaches `claude-agent-acp`.
- The later OAuth credential resolved through the SDK+ACP smoke was not accepted by Claude Code through the ACP route; the observable provider error was `401 Invalid bearer token`.

Discarded:

- OpenHands SDK silently strips OAuth before child launch.
- The original auth failure is another form of the model+effort bug.
- Adding an API-key workaround is appropriate while an OAuth credential is configured as dominant.

UNPROVEN:

- Whether the main container's `ANTHROPIC_API_KEY` would work in isolation today. The task states it exists, but it was not accessible from this workspace without Docker/backend access.
- Whether the earlier direct OAuth success and later ACP OAuth 401 were caused by credential rotation, expiry/revocation, a different resolver value, or Claude Code state outside the repository. The repository-controlled boundary is proven by request-body tests and child-env probes; the external credential lifecycle is not fully observable from this follow-up workspace.
- A full Agent Canvas conversation response after the repository fix. The fixed boundary was exercised through SDK+ACP, but the available OAuth credential currently fails provider authentication before an assistant response can be produced.

## Commands And Sanitized Results

- `git status -sb`: detached HEAD in isolated worktree at the reviewed SHA before follow-up edits.
- `node` profile/env probe: local Claude profile exists, id present with length 36, name `claude`, `agent_kind="acp"`, `secret_refs=null`; no `OH_AGENT_PROFILE_ID`, `OH_CLAUDE_AGENT_PROFILE_IDS`, `OH_CONVERSATION_SECRET_REFS`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, or `CLAUDECODE` set in this follow-up workspace process.
- `python` SDK inspection: `openhands-sdk=1.49.4`; module `/usr/local/lib/python3.13/site-packages/openhands/sdk/agent/acp_agent.py`; `ACP_PROVIDERS["claude-code"].api_key_env_var="ANTHROPIC_API_KEY"`; `env_conflicts` has dominant `CLAUDE_CODE_OAUTH_TOKEN` stripping `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`; `_start_acp_server` source contains `os.environ`, `secret_registry`, and `_strip_conflicting_env`.
- `npx --yes @agentclientprotocol/claude-agent-acp@0.63.0 --version`: `0.63.0`.
- OpenHands package inspection: `openhands-sdk 1.49.4`; `StartConversationRequest` accepted the generated UUID profile request and produced `LookupSecret`.
- Claude profile inspection: `~/.openhands/agent-profiles/claude.json` showed Claude ACP settings and `secret_refs=null`; no secrets printed.
- Failed conversation inspection from the original investigation: state/events for `65b89aa5-4d28-5dbd-9f77-e4f2b1ddfed1` showed `ACPAuthRequired`, `claude-agent-acp` 0.63.0, `runtime_status=available`, and model `opus[1m]`.
- Secret store presence probe from the original investigation: `CLAUDE_CODE_OAUTH_TOKEN=present`, `ANTHROPIC_API_KEY=absent` in the readable local store; values not printed.
- ACP child env probe from the original investigation: `CLAUDE_CODE_OAUTH_TOKEN=true`, `ANTHROPIC_API_KEY=false`, `ANTHROPIC_BASE_URL=false`, `CLAUDECODE=false`.
- Direct OAuth smoke from the original investigation: Claude Code returned sanitized tail `ok`.
- Local backend access after reviewer feedback: `/api/settings`, `/api/agent-profiles`, and `/api/conversations/search` returned HTTP 403 with the available session key.
- OpenHands SDK+Claude ACP smoke after reviewer feedback: fixed `LookupSecret` path delivered the OAuth credential to `claude-agent-acp` 0.63.0; provider returned sanitized `401 Invalid bearer token`; no assistant response was produced.
- Docker availability: Docker CLI exists, but daemon/socket was unavailable, so no Docker image build or main-container inspection was performed.
- Regression checks after this follow-up: `npm test` and `npm run typecheck` pass.

## Smoke Status

The original direct Claude Code OAuth smoke passed and did not show `ACPAuthRequired`.

The post-fix SDK+ACP smoke no longer demonstrates the repository's previous omission of `StartConversationRequest.secrets`; it demonstrates the next boundary instead. The OAuth credential is delivered to Claude ACP and the provider rejects the resolved value with `401 Invalid bearer token`.

Because the resolved credential was rejected in the available ACP smoke, and this follow-up workspace cannot re-read or replace the backend secrets, criterion 25 cannot be completed here with a successful assistant response. The required operational action is to renew or replace `CLAUDE_CODE_OAUTH_TOKEN` in the OpenHands/Agent Canvas secret store, then rerun the same minimal Claude ACP smoke. The repository should not hide that with an API-key fallback workaround while OAuth remains configured as the dominant Claude credential.
