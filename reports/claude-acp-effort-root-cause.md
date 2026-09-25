# Claude ACP effort root cause report

Task: `claude-acp-effort-root-cause-report-v3`

Conversation investigated: `c20dfea1-1ceb-4c98-be51-59d7c8c59ff6`

Date of investigation: 2026-09-25

## Executive finding

The observed failure is a model-selection failure, not proof of a Claude quota exhaustion failure.

The persisted Canvas/OpenHands value was the logical combined value `opus[1m]/high`. In the installed OpenHands SDK 1.49.4 patch, that value is split before provider-facing model configuration:

- `model` config option: `opus[1m]`
- `effort` config option: `high`
- legacy `set_session_model` model id: `opus[1m]`
- `session/new` Claude `_meta` model option: `opus[1m]`

The string `opus[1m]/high` in `available_models` came from the live Claude ACP model menu treating the configured custom value as a custom model entry. That happens when the configured/allowlisted model value is `opus[1m]/high`, which `claude-agent-acp` 0.63.0 will surface verbatim as a selectable custom model and pass to `query.setModel` if selected. The currently installed OpenHands patch prevents that combined value from being sent through OpenHands' direct model-apply paths.

The final error text mentioned `opus[1m]/high[1m]`. Static evidence shows `[1m]` is a Claude Code context-window hint used by the Claude binary and SDK. The extra trailing `[1m]` is error/display text produced below OpenHands, not a separate OpenHands effort suffix. The exact backend-bound model id inside the proprietary Claude binary cannot be proven from static source alone, but the available evidence shows two different mechanisms:

- `opus[1m]/high` can be sent as a model id if it reaches `claude-agent-acp` as a model option/custom model before OpenHands splits it.
- The final `.../high[1m]` spelling is a Claude Code formatted model label, because the binary contains the exact model-not-found message template and many `[1m]` model label strings.

The account reportedly had no Claude Pro quota during the smoke test. That can explain why a real smoke test could not complete inference. It does not explain the observed `model_not_found` subtype by itself. The conversation log recorded `model_not_found`, not `rate_limit`, `billing_error`, `permission_denied`, or `overloaded`.

## Repository and runtime state checked

The local repo was on `diag/claude-acp-effort-root-cause-v2`, tracking `origin/diag/claude-acp-effort-root-cause-v2`, with no local changes before this report. The branch pointed at the same commit as `main`, so the report did not already exist.

The installed Python package reported `openhands-sdk==1.49.4`. The installed Node ACP package used by `npx` was `@agentclientprotocol/claude-agent-acp@0.63.0`, and its `package.json` pins `@anthropic-ai/claude-agent-sdk@0.3.220`. The Claude Agent SDK package reported bundled Claude Code version `2.1.220`.

`gh` was not authenticated in the local shell, so local PR inspection with `gh pr list` failed before any repo changes. GitHub operations should use an authenticated connector or an environment with `GH_TOKEN`.

## Chronology from the c20dfea1 conversation logs

The persisted conversation directory is:

`/home/openhands/.openhands/agent-canvas/conversations/c20dfea11ceb4c98be5159d7c8c59ff6`

The base state keeps the dashed conversation id:

`c20dfea1-1ceb-4c98-be51-59d7c8c59ff6`

Observed events:

| Time UTC | Event | Evidence |
|---|---|---|
| 2026-09-25 05:55:09.863703 | Conversation agent settings existed with `llm.model="opus[1m]"` and `reasoning_effort="high"`. | `event-00000-c821...json` |
| 2026-09-25 05:55:09.946405 | Agent state recorded `acp_current_model_id="opus[1m]/high"`. | `event-00001-6220...json` |
| 2026-09-25 05:56:59.955655 | ACP session started with `@agentclientprotocol/claude-agent-acp`, version `0.63.0`, session id `3b18f97d-...`, `acp_model_via_config_option=true`. | `event-00004-aed...json` |
| 2026-09-25 05:56:59.955655 | Available models were `default`, `sonnet`, `opus`, `haiku`, plus `opus[1m]/high` as `Custom model`. | `event-00004-aed...json` |
| 2026-09-25 05:57:00.394207 | A user prompt became inflight while current model still displayed as `opus[1m]/high`. | `event-00007-2345...json` |
| 2026-09-25 05:57:50.468353 | Claude ACP returned `ACP error: [-32603] Internal error: There's an issue with the selected model (opus[1m]/high[1m]). It may not exist or you may not have access to it.: {"errorKind": "model_not_found"}`. | `event-00008-ef8...json` |
| 2026-09-25 05:57:50.546697 | ConversationErrorEvent followed. | `event-00009-84b...json` |
| 2026-09-25 05:57:50.753853 | Final agent state still showed `acp_current_model_id="opus[1m]/high"` and the custom available model row. | `event-00011-748...json` |

No event in this conversation records `rate_limit`, `billing_error`, `permission_denied`, or `quota`. The only terminal error subtype captured in the assistant message is `model_not_found`.

## OpenHands data flow

### `LocalConversation.switch_acp_model`

File: `/usr/local/lib/python3.13/site-packages/openhands/sdk/conversation/impl/local_conversation.py`

Function: `LocalConversation.switch_acp_model`

Lines inspected: 1724-1795.

This method persists the selected ACP model by replacing the frozen `ACPAgent` with `old_agent.model_copy(update={"acp_model": model})`. When a live session exists, it first calls `self.agent.set_acp_model(model)` and only persists after the live switch succeeds. Without a live session, it just persists and session creation applies the value later.

The persisted value is the logical Canvas value. For this task, that value was `opus[1m]/high`.

### `ACPAgent` model patch

File: `/usr/local/lib/python3.13/site-packages/openhands/sdk/agent/acp_agent.py`

Relevant functions:

- `_claude_model_config_options`
- `_model_config_options`
- `_model_config_model_value`
- `_apply_acp_model`
- `_maybe_set_session_model`
- `_reapply_session_model_on_resume`
- `ACPAgent.set_acp_model`
- session creation around `conn.new_session`

The installed patch defines `_CLAUDE_EFFORTS = {"low", "medium", "high", "xhigh", "max"}` and maps a Claude combined value by splitting at the final slash. For `opus[1m]/high`, `_claude_model_config_options` returns:

```text
(("model", "opus[1m]"), ("effort", "high"))
```

`_apply_acp_model` sends those values via `conn.set_config_option` when `via_config_option=true`. In the legacy branch it sends `_model_config_model_value(...)`, so the legacy `set_session_model` call also receives only `opus[1m]`.

Session creation also strips the effort before creating Claude `_meta`:

```text
session_model = _model_config_model_value(agent_name, self.acp_model)
session_meta = build_session_model_meta(agent_name, session_model)
conn.new_session(..., **session_meta)
```

For Claude this builds:

```text
{"claudeCode": {"options": {"model": "opus[1m]"}}}
```

### Local instrumentation of OpenHands split

This local instrumentation did not send a prompt or start Claude inference. It invoked OpenHands helpers against a fake connection:

```text
via_config_option=True:
  set_config_option("model", "opus[1m]")
  set_config_option("effort", "high")

via_config_option=False:
  set_session_model("opus[1m]")

session_meta:
  {"claudeCode": {"options": {"model": "opus[1m]"}}}
```

This independently verifies that the currently installed OpenHands SDK 1.49.4 patch does not send `opus[1m]/high` through these provider-facing OpenHands paths.

## Claude ACP 0.63.0 flow

Package: `/home/openhands/.npm/_npx/3e28e223a0aba92d/node_modules/@agentclientprotocol/claude-agent-acp`

Version: `0.63.0`

Dependency: `@anthropic-ai/claude-agent-sdk@0.3.220`

### `createSession` and `getAvailableModels`

`ClaudeAcpAgent.createSession` reads settings, creates an SDK query, calls `q.sdkInit()`, applies `availableModels` allowlists through `applyAvailableModelsAllowlist`, then calls `getAvailableModels`.

`getAvailableModels` picks current model by this priority:

1. `ANTHROPIC_MODEL`
2. `settings.model`
3. resumed live model from `query.getContextUsage`
4. `models[0]`

If an override resolves to an alias or allowlist value that differs from what the SDK would already use, it calls:

```text
query.setModel(currentModel.value)
```

The returned ACP `modelState.availableModels` is built directly from `models.map(model => ({modelId: model.value, ...}))`.

### `applyAvailableModelsAllowlist`

`applyAvailableModelsAllowlist` preserves `default` and then appends each allowed string as the `value` used by downstream `setModel`. If the allowlist entry is not an exact SDK value but fuzzy-matches an SDK model, it copies display/capability information from the SDK match while preserving the allowlist string as the target value.

This is how `available_models` can contain:

```text
{"model_id": "opus[1m]/high", "name": "opus[1m]/high", "description": "Custom model"}
```

or, with a nearby SDK match:

```text
{"model_id": "opus[1m]/high", "name": "Opus", ...}
```

Either way, if the value reaches the model option, `query.setModel` receives the exact string.

### `setSessionConfigOption`

`ClaudeAcpAgent.setSessionConfigOption` finds the option by `params.configId`, validates `params.value`, resolves aliases for the `model` option, then:

```text
if (params.configId === MODEL_CONFIG_ID) {
  await this.sessions[params.sessionId].query.setModel(resolvedValue);
}
await this.applyConfigOptionValue(...);
```

For `configId="effort"`, `applyConfigOptionValue` calls:

```text
session.query.applyFlagSettings({ effortLevel: toSdkEffortLevel(value) })
```

For `value="high"`, `toSdkEffortLevel` returns `"high"`.

### Local instrumentation of Claude ACP model resolution

This local test imported the exported pure helpers from `claude-agent-acp` and did not start the Claude binary or send inference.

With normal SDK models only:

```text
resolveModelPreference(models, "opus[1m]/high") -> "opus"
resolveModelPreference(models, "opus[1m]")      -> "opus"
effort option includes high/max from Opus capabilities
```

With an allowlist/custom model entry `["opus[1m]/high"]`:

```text
applyAvailableModelsAllowlist(...).models contains value "opus[1m]/high"
resolveModelPreference(models, "opus[1m]/high") -> "opus[1m]/high"
resolveModelPreference(models, "opus[1m]")      -> "opus[1m]/high"
model config option value                       -> "opus[1m]/high"
effort option currentValue                      -> "high"
```

With an allowlist/custom model entry `["opus[1m]"]`:

```text
model config option value -> "opus[1m]"
effort option currentValue -> "high"
```

This proves that the custom/allowlist route can preserve the combined `model/effort` string as the actual `setModel` target. It also proves that after OpenHands splits the value, `claude-agent-acp` receives `opus[1m]` as the model target and `high` as the effort flag.

## Anthropic Claude Agent SDK and Claude binary flow

Package: `/home/openhands/.npm/_npx/3e28e223a0aba92d/node_modules/@anthropic-ai/claude-agent-sdk`

Version: `0.3.220`

Bundled Claude Code version: `2.1.220`

The SDK TypeScript declarations define:

- `Query.setModel(model?: string): Promise<void>`
- `Query.applyFlagSettings(settings): Promise<void>`
- `ModelInfo.value` as the "Model identifier to use in API calls"
- `ModelInfo.resolvedModel` as the canonical wire model id a row resolves to
- effort levels: `low`, `medium`, `high`, `xhigh`, `max`

The minified SDK implementation writes control requests:

```text
{subtype: "set_model", model: e}
{subtype: "apply_flag_settings", settings: e}
```

Strings extracted from the bundled Claude binary show:

- the exact error template `There's an issue with the selected model (...)`
- `model_not_found`
- `set_model`
- `apply_flag_settings`
- `opus[1m]`
- many other `[1m]` model labels

Because the binary is proprietary/minified native code, static analysis cannot prove the final HTTP request body sent to Anthropic. However, it can prove that the final error text and `[1m]` display syntax exist in the Claude binary, below OpenHands and below `claude-agent-acp`.

## What `opus[1m]/high[1m]` is

`opus[1m]/high[1m]` is not an OpenHands serialization format and is not produced by the installed OpenHands split patch.

It is best explained as Claude Code rendering a selected model label with a context-window hint. If the selected model string was still `opus[1m]/high` when the Claude binary handled it, the binary can append/display its own `[1m]` hint and produce `opus[1m]/high[1m]` in the error text.

The proven source of `opus[1m]/high` in `available_models` is the Claude ACP model menu/custom model path. The exact source of the final extra `[1m]` is the Claude binary display/error layer; the exact backend-bound model string in the failing smoke cannot be proven from available logs alone because the log captures the error text, not the raw `set_model` control request or API request.

## Quota analysis

The task states that the Claude Pro account had no quota available during the smoke test. That can affect a real smoke test in these ways:

- It can prevent successful inference even with correct model and effort configuration.
- It can mask a fixed configuration path because a final real prompt still cannot complete.
- It can make smoke testing inconclusive until quota returns.

It does not fully explain the observed conversation failure:

- The captured terminal subtype is `model_not_found`.
- The user-visible text says the selected model may not exist or may not be accessible.
- The conversation log does not show `rate_limit`, `billing_error`, `overloaded`, or `permission_denied`.
- Claude Agent SDK type declarations distinguish `model_not_found`, `rate_limit`, `billing_error`, `permission_denied`, and `overloaded` as separate error categories.

Therefore quota is a separate smoke-test blocker, not the demonstrated root cause of the `opus[1m]/high[1m]` `model_not_found` error.

## Hypotheses

| Hypothesis | Status | Evidence |
|---|---|---|
| OpenHands persisted the combined logical value `opus[1m]/high`. | CONFIRMED | `LocalConversation.switch_acp_model` persists the caller value as `acp_model`; c20 events show `acp_current_model_id="opus[1m]/high"`. |
| The installed OpenHands SDK 1.49.4 patch still sends `opus[1m]/high` through `_apply_acp_model` for Claude. | RULED_OUT | Static code and fake-connection instrumentation show `set_config_option("model","opus[1m]")`, `set_config_option("effort","high")`, and legacy `set_session_model("opus[1m]")`. |
| `build_session_model_meta` still sends the combined value in `session/new` `_meta`. | RULED_OUT | Installed code calls `_model_config_model_value` before `build_session_model_meta`; local instrumentation returns `{"claudeCode":{"options":{"model":"opus[1m]"}}}`. |
| `claude-agent-acp` can surface `opus[1m]/high` in `available_models` as a custom model. | CONFIRMED | c20 logs show that row; `applyAvailableModelsAllowlist` preserves allowlist/custom values as model option `value`. |
| If `claude-agent-acp` receives `opus[1m]/high` as a model option, it can pass that exact value to `query.setModel`. | CONFIRMED | `setSessionConfigOption` calls `query.setModel(resolvedValue)` for the model option; local pure-helper instrumentation shows `resolvedValue="opus[1m]/high"` when that value is in the model list. |
| After OpenHands splits the logical value, `claude-agent-acp` sends `model=opus[1m]` and `effort=high` through separate SDK control requests. | CONFIRMED | OpenHands instrumentation proves the split before ACP; `claude-agent-acp` code routes model changes to `query.setModel` and effort to `query.applyFlagSettings({effortLevel:"high"})`. |
| `opus[1m]/high[1m]` is an OpenHands-generated model id. | RULED_OUT | No OpenHands code appends a final `[1m]`; OpenHands patch emits `opus[1m]` and `high` separately. |
| The final extra `[1m]` is Claude Code display/error formatting. | CONFIRMED | The bundled Claude binary contains the exact selected-model error template, `model_not_found`, and many `[1m]` model labels including `opus[1m]`. |
| The exact raw Anthropic API `model` field in the failing smoke can be proven from existing logs alone. | UNPROVEN | Logs contain the ACP error text, not raw SDK `set_model` or API request bodies. |
| Lack of Claude Pro quota caused the observed `model_not_found`. | UNPROVEN | Quota was reported separately, but c20 logs show `model_not_found`, not a quota/rate/billing error. |

## Root cause

The root cause is an overloaded single-string model representation crossing component boundaries.

Canvas/OpenHands used `opus[1m]/high` to represent two independent choices:

- Claude model/context alias: `opus[1m]`
- Claude effort: `high`

Older or unpatched provider-facing paths treated the whole string as a Claude model id. In `claude-agent-acp` 0.63.0, a configured model value can become a custom model entry and be passed as the exact `query.setModel` target. Claude Code then treats that value as the selected model and reports it in a `model_not_found` error with an additional context hint, yielding the observed `opus[1m]/high[1m]` text.

The current OpenHands patch fixes the direct split for `_apply_acp_model`, session `_meta`, fresh sessions, resume/reconnect, and legacy model application. The smoke can still fail if another path injects `opus[1m]/high` into Claude ACP settings, allowlist, environment (`ANTHROPIC_MODEL`, `ANTHROPIC_CUSTOM_MODEL_OPTION`, `CLAUDE_MODEL_CONFIG.availableModels`), or persisted Claude config outside the patched OpenHands call path. The c20 log's custom available-model row is the strongest evidence of such an injected custom/model-list value.

## Why previous tests gave false positives

Earlier tests verified only the OpenHands patch in isolation. They used fake ACP connections and asserted that `_model_config_options` split `opus[1m]/high` into `model=opus[1m]` and `effort=high`.

Those tests did not cover:

- Claude ACP's `availableModels`/custom model route.
- `applyAvailableModelsAllowlist` preserving arbitrary strings as model values.
- `settings.model`, `ANTHROPIC_MODEL`, `ANTHROPIC_CUSTOM_MODEL_OPTION`, or `CLAUDE_MODEL_CONFIG.availableModels`.
- The SDK control boundary where `query.setModel` and `query.applyFlagSettings` are separate.
- The Claude binary's display/error formatting.
- A real account with dynamic model access and quota state.

They passed because the OpenHands helper behavior was correct, while the real failure involved downstream model-list/custom-model state and a real Claude Code error path.

## Recommended fix design

### Minimal fix

Keep accepting the current logical UI string temporarily, but normalize at every boundary that can feed Claude model selection:

1. Parse Claude `acp_model` into `{model, effort}` once.
2. Use only `model` for:
   - `session/new` `_meta.claudeCode.options.model`
   - `session/set_config_option` with `configId="model"`
   - legacy `set_session_model`
   - any generated Claude settings or allowlists
   - any custom model option/environment forwarding
3. Use only `effort` for:
   - `session/set_config_option` with `configId="effort"`
   - eventually `query.applyFlagSettings({effortLevel})`
4. Add a guard that rejects or rewrites Claude model strings matching `<model>/<effort>` before they enter Claude ACP settings/allowlists/env.

This is the smallest production fix if the runtime still needs backward compatibility with saved `acp_model="opus[1m]/high"`.

### Robust fix

Stop encoding model and effort in one string. Persist them as independent fields, for example:

```json
{
  "acp_model": "opus[1m]",
  "acp_effort": "high"
}
```

or a structured provider config:

```json
{
  "acp_provider_config": {
    "model": "opus[1m]",
    "effort": "high"
  }
}
```

The model picker should select only provider model ids. Effort should be a separate option whose availability is derived from the selected model's capabilities. Compatibility migration can read old `model/effort` strings and populate the new fields, but new writes should never persist Claude effort in the model id.

This design matches Claude ACP and Claude Agent SDK semantics: `setModel(model)` and `applyFlagSettings({effortLevel})` are separate control requests.

## Regression tests needed

Unit tests:

- `opus[1m]/high -> model=opus[1m], effort=high`
- `opus[1m] -> model=opus[1m]` and no synthetic effort
- `sonnet/medium -> model=sonnet, effort=medium`
- `opus[1m]/max -> model=opus[1m], effort=max`
- Claude efforts include `low`, `medium`, `high`, `xhigh`, `max`
- invalid suffixes like `opus[1m]/foobar` are not silently treated as effort

Fake ACP tests:

- `session/new` receives Claude `_meta` model `opus[1m]`
- fresh-session `_maybe_set_session_model` sends `model=opus[1m]`, `effort=high`
- runtime `switch_acp_model` sends `model=opus[1m]`, `effort=high`
- resume/reconnect reapply sends `model=opus[1m]`, `effort=high`
- no fake call receives `opus[1m]/high` as a provider-facing model

Claude ACP adapter tests:

- mock `query.setModel` and `query.applyFlagSettings`
- verify `set_config_option(model, "opus[1m]")` calls `setModel("opus[1m]")`
- verify `set_config_option(effort, "high")` calls `applyFlagSettings({effortLevel:"high"})`
- verify a combined value in `availableModels` would call `setModel("opus[1m]/high")`, so production code must prevent creating that state

Integration tests:

- run OpenHands SDK against a fake Claude ACP server that advertises `configOptions` and records JSON-RPC `session/set_config_option`
- run a no-inference `claude-agent-acp` harness with a mocked Claude Agent SDK query object to capture `setModel` and `applyFlagSettings`
- verify persisted resume state reapplies split fields

Real smoke test, only when Claude quota is available:

- use an account with access to the target Opus/1M model
- run a minimal prompt after selecting `opus[1m]` and `high`
- capture sanitized evidence of selected model, effort config, and response
- separately record whether any failure is `model_not_found`, `rate_limit`, `billing_error`, or quota-related

## Evidence commands run

No real Claude prompts were sent and no Claude quota was consumed. The investigation used:

- static reads of installed OpenHands SDK 1.49.4 source
- static reads of cached `@agentclientprotocol/claude-agent-acp@0.63.0`
- static reads of cached `@anthropic-ai/claude-agent-sdk@0.3.220`
- `strings` over the local Claude binary for error templates and model-label strings
- fake Python connection instrumentation around OpenHands `_apply_acp_model`
- Node pure-helper instrumentation around Claude ACP model resolution and config option construction

No secrets were printed or copied.
