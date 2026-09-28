# oquestador

oquestador is a proof of concept for coordinating development agents through OpenHands. It keeps control of workspace isolation, workflow state, GitHub publication, review loops, recovery, and deterministic merge decisions while Implementer and Reviewer agents focus on their roles.

BOOT-01 turned the original CLI-only proof of concept into a reusable core with two front ends that share it: the original CLI (`src/orchestrator.ts`) and a persistent HTTP Control Plane (`src/control-plane/`). See [Reusable core (BOOT-01)](#reusable-core-boot-01) and [Control Plane (BOOT-01)](#control-plane-boot-01) below.

## Workflow

The normal workflow is:

```text
PREPARING -> IMPLEMENTING -> REVIEWING -> MERGING -> DONE
     |             |             |
     |             |             +-> BLOCKED (BLOCKED_EXTERNAL, maxReviewCycles, repeated blocker)
     +-> BLOCKED    +-> BLOCKED (BLOCKED_EXTERNAL)

Any in-flight state -> PAUSED (cooperative pause) -> resumes back into the same state
Any in-flight state -> CANCELLED (cooperative cancel, terminal)
```

During `PREPARING`, an agent validates the isolated workspace. It returns exactly `PREPARATION_RESULT: READY` or `PREPARATION_RESULT: BLOCKED`. A blocked preparation is not treated as a workflow failure: `RunState` keeps the reason and a later run resumes from preparation.

During `IMPLEMENTING`, the agent edits and commits inside the task worktree. It does not push and does not create a Pull Request. The orchestrator publishes the exact worktree HEAD and creates or reuses the Pull Request. The Implementer may also return `IMPLEMENTATION_RESULT: BLOCKED_EXTERNAL` with a mandatory `IMPLEMENTATION_REASON` (and an optional `BLOCKER_KEY`) when it hits a blocker outside its control (missing external approval, unavailable third-party service, etc.); this ends the run in `BLOCKED` without publishing anything.

During `REVIEWING`, the Reviewer inspects the real Pull Request HEAD and returns `APPROVED`, `CHANGES_REQUESTED`, or `BLOCKED_EXTERNAL` (same reason/blocker-key contract as above, via `REVIEW_VERDICT`/`REVIEW_REASON`). `CHANGES_REQUESTED` returns to `IMPLEMENTING`, subject to two independent limits described below.

After `APPROVED`, `MERGING` verifies that the Pull Request HEAD still matches the reviewed SHA and performs the merge only for that approved revision.

### Review cycle limits

Two independent, deterministic checks can end a `CHANGES_REQUESTED` loop in `BLOCKED` instead of starting another Implementer↔Reviewer cycle:

- **`WorkflowTask.maxReviewCycles`** — once `implementationCycle` reaches this value, another `CHANGES_REQUESTED` verdict ends the run in `BLOCKED` (reason: `Reached maxReviewCycles=<n> without reviewer approval.`) instead of starting cycle `n + 1`. The workspace and any published PR are left untouched.
- **Repeated blocker detection (`BLOCKER_KEY`)** — the Reviewer can tag a `CHANGES_REQUESTED` verdict with a one-line `BLOCKER_KEY: <token>` (letters, digits, `.`, `_`, `-`, `:`). If the *same* key reappears on consecutive review cycles up to `WorkflowTask.repeatedBlockerThreshold` (default 3), the run ends in `BLOCKED` (reason mentions the key and the repeat count) instead of looping again. This is purely a literal-string match on an explicit, agent-supplied field — never semantic inference over the feedback text — so it only fires when the agent itself signals "this is the same blocker as last time."

Neither check applies without an explicit signal: a `CHANGES_REQUESTED` verdict with no `BLOCKER_KEY` never counts toward the repeated-blocker threshold, and tasks without `maxReviewCycles` never hit that limit.

## Isolated worktrees

Each task gets its own deterministic workspace:

```text
/projects/.orchestrator-worktrees/<task-id>-<scope-hash>
```

The source checkout is not switched, reset, stashed, or reused as the agent workspace. New worktrees are created in detached-HEAD mode from either the existing remote working branch or `origin/<baseBranch>`. Detached HEAD is intentional: it avoids Git branch checkout conflicts when multiple worktrees or tasks exist simultaneously.

The task ID is restricted to letters, numbers, dots, underscores, and hyphens so it cannot escape the worktree root. The short scope hash is derived from repository owner/name, base branch, and working branch, so reusing a task ID with a different repository or branch cannot silently reuse the wrong worktree.

A worktree is preserved when the task is `BLOCKED` or `FAILED`. Cleanup is attempted only after `DONE`, and only when the workspace is clean and its HEAD exactly matches the published remote working branch.

## Orchestrator-owned GitHub writes

Agents no longer need an authenticated `git push` or `gh pr create` session inside Agent Canvas.

The orchestrator:

1. validates that the workspace `origin` points to the expected GitHub repository;
2. refuses to publish a workspace with uncommitted changes;
3. obtains the host GitHub CLI token without logging it;
4. passes that token to the container through stdin only;
5. uses a temporary credential file for the push and removes it immediately;
6. publishes the detached worktree HEAD to the configured working branch;
7. creates or reuses exactly one open Pull Request for the configured head/base pair.

Pull Request lookup and creation are idempotent. Existing repository/base/head/HEAD-SHA validations remain in force, and merge still uses the approved HEAD SHA.

## OpenHands recovery

`OpenHandsClient` distinguishes transport/API failures from terminal agent failures.

Transient transport conditions include:

- HTTP 502, 503, and 504;
- `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`;
- common fetch/socket/network reset failures.

During conversation polling, Agent Canvas may also briefly expose an incomplete persisted conversation state. A narrowly matched HTTP 500 whose sanitized backend error is specifically `No such file or directory` for `/agent-canvas/conversations/.../base_state.json` is treated like the existing transient conversation 404 path: it receives the same bounded retry budget. Unrelated HTTP 500 responses remain non-transient and are not retried blindly.

These use bounded exponential backoff. Transient conversation 404s are also bounded.

If the retry budget is exhausted, the workflow records `failureKind: TRANSIENT` while preserving the active stage and conversation ID. Re-running the same task can resume that stage and the same deterministic conversation rather than creating a duplicate.

An actual OpenHands `execution_status=error` or `stuck` remains a terminal agent condition. It is recorded separately as `TERMINAL`; the orchestrator does not blindly retry semantic agent failures.

### Resource exhaustion (`RESOURCE_LIMIT`)

A terminal condition is only ever classified as resource/quota exhaustion when the `AgentClient` exposes explicit, reproducible evidence for it — never by guessing from a generic terminal error. `AgentClient` has an optional `getTerminalErrorDetail(conversationId)` method; when a stage ends in `ConversationTerminalError`, the orchestrator calls it (if implemented) and checks the returned `{ code, detail }` against a small allowlist (`rate_limit`, `usage_limit_exceeded`, `quota_exceeded`, `billing_error`, or `detail` text matching `usage limit`/`quota exceeded`/`rate limit exceeded`). Only a match produces `failureKind: RESOURCE_LIMIT`; any other terminal detail (including unknown or absent detail) stays `TERMINAL`, and if the client does not implement `getTerminalErrorDetail` at all, classification is skipped entirely and the failure remains `TERMINAL` — matching the historical CLI behavior of `OpenHandsClient` today. `RESOURCE_LIMIT` preserves the active stage and conversation ID exactly like `TRANSIENT`, so it is resumable, but nothing in this codebase retries it automatically: resuming is always an explicit operator action (the Control Plane's `POST /resume`, or an explicit CLI re-run).

## RunState

RunState version 5 stores:

- workflow state and preparation attempt;
- implementation/review cycle information;
- Pull Request and reviewed/approved HEAD SHAs;
- active stage and deterministic conversation IDs;
- reviewer feedback;
- BLOCKED reason;
- failure kind/message (`TRANSIENT`, `TERMINAL`, `WORKFLOW`, or `RESOURCE_LIMIT`);
- merge result;
- `controlSignal` (`NONE` / `PAUSE_REQUESTED` / `CANCEL_REQUESTED`) plus `pausedFromState`/`cancelledFromState`, used by the cooperative pause/cancel checkpoint (see below);
- `lastBlockerKey` / `repeatedBlockerCount`, used by repeated-blocker detection.

Versions 1 through 4 are migrated when read; migrating a version 4 state only adds the new version 5 fields and does not touch any existing value (earlier migrations reset a few fields that did not exist yet in those older versions).

### Cooperative pause and cancel

`WorkflowState` includes two additional terminal-ish states, `PAUSED` and `CANCELLED`, alongside the existing `PREPARING`/`IMPLEMENTING`/`REVIEWING`/`MERGING`/`BLOCKED`/`DONE`/`FAILED`. The workflow loop checks `controlSignal` at every safe checkpoint — the top of the loop, which is only reached between two fully completed stages (or before the merge step), never while a stage's agent conversation is actually in flight:

- if `controlSignal` is `CANCEL_REQUESTED` at a checkpoint, the run ends in `CANCELLED` (recording `cancelledFromState`) without starting the next stage or attempting a merge;
- if `controlSignal` is `PAUSE_REQUESTED` at a checkpoint, the run ends in `PAUSED` (recording `pausedFromState`) the same way;
- if a conversation is already running when the signal arrives, the workflow lets that one stage finish (there is no safe mid-conversation cancellation) and only intercepts the *next* one — so the caller sees `PAUSE_REQUESTED`/`CANCEL_REQUESTED` (a Control-Plane-level status, see below) until the checkpoint is actually reached; it never fakes an immediate interruption.

Resuming a `PAUSED` run restores `workflowState` from `pausedFromState` and clears the signal; it is handled automatically the next time `runWorkflow` is invoked for that task, the same way an existing `BLOCKED` state is automatically retried from `PREPARING`. `CANCELLED` (like `DONE`) is a terminal, idempotent rest state: re-running does nothing. Neither pause nor cancel deletes the worktree or `RunState`; both stay in place for audit and for `CANCELLED`'s (non-)resumability to be inspected later.

## Reusable core (BOOT-01)

The workflow state machine lives in `src/workflowEngine.ts` (`runWorkflow` plus every helper it needs — GitHub/PR handling, resource-limit classification, etc.). `src/taskRunner.ts` wraps it with the rest of a task's lifecycle — resolving/validating the `WorkflowTask`, preparing an isolated worktree, running the workflow to a checkpoint, and cleaning up only after a genuine `DONE` — as a single `runTask(options, deps)` function. That function has no side effects on import and is the one thing both front ends call:

- the CLI, `src/orchestrator.ts`, resolves its `WorkflowTask` from `WORKFLOW_TASK_FILE` and its `AgentClient`/`GitHubClient` from environment variables, then calls `runTask` once and exits;
- the Control Plane, `src/control-plane/runManager.ts`, resolves the task from an allowlisted task root by `taskId` and calls `runTask` per HTTP-initiated run, without blocking the HTTP request on it.

Neither front end reimplements any part of the workflow; `npx tsx src/orchestrator.ts` still works exactly as before.

## Control Plane (BOOT-01)

`src/control-plane/` is a small, dependency-free HTTP server built directly on Node's `node:http` (no Express/Fastify — routing is a handful of exact-path/regex checks in `server.ts`). It lets other tools (a future Agent Canvas integration in BOOT-02, or plain `curl`) start, observe, pause, resume, and cancel the same tasks the CLI runs, without ever blocking an HTTP request on a whole workflow.

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness only. |
| `GET` | `/api/tasks` | Bearer | Lists valid task metadata from `ORCHESTRATOR_TASK_ROOT`; invalid files are ignored safely. |
| `GET` | `/api/tasks/:taskId` | Bearer | Returns one valid task's public metadata. 404 if the task is unknown. |
| `GET` | `/api/runs` | Bearer | Lists every known run (from the Control Plane's own run registry) with its live status. |
| `GET` | `/api/runs/:runId` | Bearer | 404 if the runId is unknown. |
| `POST` | `/api/runs` | Bearer | Body: `{ "taskId": "...", "agentProfileId"?: "..." }`. Starts the run asynchronously and returns immediately (`202`) with the new `runId` and initial status; the HTTP connection never stays open for the workflow to finish. |
| `POST` | `/api/runs/:runId/pause` | Bearer | Cooperative pause request (see below). |
| `POST` | `/api/runs/:runId/resume` | Bearer | Continues a `PAUSED`, `PAUSED_RESOURCE_LIMIT`, `BLOCKED`, or `INTERRUPTED` run. Rejected (`409`) for `DONE`/`CANCELLED`. |
| `POST` | `/api/runs/:runId/cancel` | Bearer | Cooperative cancel request (see below). |

`taskId` is resolved against an allowlisted, configurable task root (`ORCHESTRATOR_TASK_ROOT`, default `tasks/`) as `<root>/<taskId>.json`; `taskId` is restricted to the same safe alphabet as `WorkflowTask.id` (letters, numbers, `.`, `_`, `-`), so it can never escape the task root, reach an arbitrary path, or execute a command. `agentProfileId` is optional per request; when omitted, the server's configured default (`OH_AGENT_PROFILE_ID`) is used, and starting a run without either configured is rejected with `400`.

### Public statuses

The Control Plane reports one of these unambiguous statuses (derived in `src/control-plane/status.ts` from the internal `WorkflowState` plus whether *this* process is currently driving the run):

`RUNNING`, `PAUSE_REQUESTED`, `PAUSED`, `CANCEL_REQUESTED`, `CANCELLED`, `BLOCKED`, `PAUSED_RESOURCE_LIMIT`, `FAILED`, `DONE`, and `INTERRUPTED` (an in-flight run left over from a previous process life after a restart — see Recovery below). The response body for any run also includes the underlying `workflowState`, `activeStage`, `blockReason`, `failureKind`, `pullRequestNumber`, `implementationCycle`, `lastReviewerVerdict`, `lastBlockerKey`, and `repeatedBlockerCount` when relevant.

### Pause and cancel semantics

Both `pause` and `cancel` only ever set a signal (or, when nothing is currently driving the run, apply the terminal state immediately since there is no in-flight stage to protect); they never touch a conversation that is already running. `pause` is only accepted from `RUNNING` (409 otherwise, including a no-op-idempotent re-pause while already `PAUSE_REQUESTED`); the run reaches `PAUSED` at the next checkpoint (see the "Cooperative pause and cancel" section above), and a request that arrives while the current stage's Implementer/Reviewer conversation is genuinely in flight is *not* faked as interrupted — the status is `PAUSE_REQUESTED` until the checkpoint is really reached. `cancel` is accepted from any non-terminal status; after `CANCEL_REQUESTED`, no new stage starts and no merge happens, and the run lands on `CANCELLED` at the next checkpoint. Neither ever deletes the worktree or persisted `RunState`.

### Duplicate runs

Starting a second run for a `taskId` that already has a non-terminal run (`RUNNING`, `PAUSE_REQUESTED`, `PAUSED`, `CANCEL_REQUESTED`, `BLOCKED`, `PAUSED_RESOURCE_LIMIT`, or `INTERRUPTED`) is rejected with `409` and the existing `runId`, instead of launching a second worker against the same `RunState`/worktree.

### Persistence and recovery

The Control Plane keeps its own small, versioned registry (`ControlPlaneRunRecord`, under `ORCHESTRATOR_CONTROL_STATE_DIR`, default `.orchestrator/control-plane/runs/`) mapping each `runId` to its `taskId`/`agentProfileId`/workspace path — no secrets. The authoritative workflow status stays in `RunState`, keyed by `taskId` (`ORCHESTRATOR_RUN_STATE_DIR`, default `.orchestrator/runs/`, same store the CLI uses). After a process restart, a run that was genuinely in flight (no one currently holding its promise) reports `INTERRUPTED` rather than a stale `RUNNING`; calling `resume` on it re-attaches to the same persisted `RunState` — same deterministic conversation IDs, same cycle counters — without recreating anything already finished.

### Authentication, binding, and secrets

Every `/api/*` route requires `Authorization: Bearer <ORCHESTRATOR_CONTROL_TOKEN>`, checked with a constant-time comparison; a missing/malformed header is `401`, a wrong token is `403`. `GET /health` needs no auth. The server refuses to start at all if `ORCHESTRATOR_CONTROL_TOKEN` is not configured. It binds to `127.0.0.1` by default; `ORCHESTRATOR_CONTROL_HOST`/`ORCHESTRATOR_CONTROL_PORT` exist so BOOT-02 can widen that, but nothing does so today. No response body, log line, or error message ever includes `ORCHESTRATOR_CONTROL_TOKEN`, `OH_SESSION_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, `ANTHROPIC_API_KEY`, or any `Authorization` header value.

### Errors and shutdown

Errors are always JSON, never a stack trace: `400` for a malformed request or invalid `taskId`, `401`/`403` for auth, `404` for an unknown run or task, `409` for an invalid state transition (duplicate run, pausing something not running, resuming something already `DONE`/`CANCELLED`, double-cancel), and `5xx` only for a genuine internal failure. `SIGINT`/`SIGTERM` (or calling `close()` directly) stop accepting new runs (`POST /api/runs` then returns `503`) and close the HTTP listener, but leave all persisted state exactly as it is; an external OpenHands conversation that was already running keeps running on the OpenHands side — the Control Plane simply stops polling it in this process until it is resumed (and, if the process was genuinely mid-workflow when it went down, that run reports `INTERRUPTED` on the next start, per the recovery behavior above).

### Out of scope for this PR

Program/Architect Mode, multi-repo/milestone routing, and model/reasoning-effort selection are explicitly later work.

## Agent Canvas MCP bridge (BOOT-02)

BOOT-02 adds a first-class MCP stdio adapter in `src/mcp/`. The runtime path is:

```text
Agent Canvas -> MCP stdio server -> HTTP Control Plane -> Orchestrator Core
```

The MCP server is only an adapter. It never imports or calls `workflowEngine` or `runTask`; all run operations go through the Control Plane HTTP API, so pause/resume/cancel and duplicate-run behavior stay owned by the orchestrator core.

### MCP tools

The server exposes these structured tools:

| Tool | Purpose |
| --- | --- |
| `orchestrator_health` | Check Control Plane reachability. |
| `orchestrator_list_tasks` | List allowlisted tasks with public metadata. |
| `orchestrator_start_task` | Start a task by `taskId`; optional `agentProfileId`. |
| `orchestrator_list_runs` | List known runs and public status. |
| `orchestrator_get_run` | Fetch one run by `runId`. |
| `orchestrator_pause_run` | Request cooperative pause. |
| `orchestrator_resume_run` | Resume a resumable run. |
| `orchestrator_cancel_run` | Request cooperative cancel. |

Tool schemas are intentionally small. `orchestrator_start_task` accepts only `taskId` and optional `agentProfileId`; it does not accept paths, shell commands, environment maps, Git operations, merge, push, or PR creation arguments.

### Configuration

Start the Control Plane on the host:

```sh
export ORCHESTRATOR_CONTROL_TOKEN=<secret-from-your-secret-store>
export ORCHESTRATOR_CONTROL_HOST=0.0.0.0
export ORCHESTRATOR_CONTROL_PORT=8787
export OH_SESSION_API_KEY=<agent-canvas-session-api-key>
export OH_AGENT_PROFILE_ID=<default-agent-profile-id>
npm run control-plane
```

`ORCHESTRATOR_CONTROL_HOST=0.0.0.0` is useful when Agent Canvas runs inside Docker and needs to reach the host through `host.docker.internal`. Keep bearer auth enabled and do not expose this listener publicly.

Configure the MCP process with:

- `ORCHESTRATOR_CONTROL_URL` — use `http://host.docker.internal:8787` from Agent Canvas running in Docker, or `http://127.0.0.1:8787` from the host.
- `ORCHESTRATOR_CONTROL_TOKEN` — supply through Agent Canvas Secrets or a secure env mechanism.
- `ORCHESTRATOR_MCP_TIMEOUT_MS` — optional request timeout override; defaults to 10000.

Run the MCP server:

```sh
npm run mcp
```

Example Agent Canvas MCP config:

```json
{
  "mcpServers": {
    "oquestador": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/projects/oquestador",
      "env": {
        "ORCHESTRATOR_CONTROL_URL": "http://host.docker.internal:8787",
        "ORCHESTRATOR_CONTROL_TOKEN": "${secrets:ORCHESTRATOR_CONTROL_TOKEN}"
      }
    }
  }
}
```

The token must not be placed in command-line args, URLs, tool names, manifests, or committed files. The MCP client sends it only as `Authorization: Bearer ...` to the Control Plane, and error responses are sanitized.

### Local smoke

Run the automated MCP smoke without real secrets:

```sh
npm run mcp:smoke
```

The smoke uses an in-process fake Control Plane client and the MCP SDK's in-memory transport. It confirms tools register and a health response is translated without depending on Agent Canvas, Docker, or external network access.

### Troubleshooting

If Agent Canvas in Docker cannot reach the Control Plane, confirm the host server is bound to an interface reachable from the container (`ORCHESTRATOR_CONTROL_HOST=0.0.0.0`) and that the MCP uses `ORCHESTRATOR_CONTROL_URL=http://host.docker.internal:8787`. If tools return `401` or `403`, check that Agent Canvas injected `ORCHESTRATOR_CONTROL_TOKEN` as an environment secret. If tools return `404` for a task, check that the task JSON is valid and lives directly under `ORCHESTRATOR_TASK_ROOT` with a safe `<taskId>.json` filename.

## Run locally

Install dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Run type checking:

```sh
npm run typecheck
```

Start the orchestrator (CLI, single task, runs to completion):

```sh
npx tsx src/orchestrator.ts
```

Useful environment variables for the CLI:

- `OH_BASE_URL`
- `OH_SESSION_API_KEY`
- `OH_AGENT_PROFILE_ID`
- `OH_CLAUDE_AGENT_PROFILE_IDS` (optional comma-separated Claude profile ids/names; the local `~/.openhands/agent-profiles/claude.json` id/name are also detected when present)
- `OH_CONVERSATION_SECRET_REFS` (optional comma-separated extra secret names to expose to each conversation through Agent Canvas lookup refs; `CLAUDE_CODE_OAUTH_TOKEN` is included by default only for detected Claude profiles and can be disabled with the client option `autoClaudeOauthSecretRef: false`)
- `OH_AGENT_CONTAINER` (defaults to `openhands-canvas`)
- `OH_WORKTREE_ROOT` (defaults to `/projects/.orchestrator-worktrees`)
- `WORKFLOW_TASK_FILE`

Start the Control Plane (persistent HTTP server; see [Control Plane (BOOT-01)](#control-plane-boot-01)):

```sh
export ORCHESTRATOR_CONTROL_TOKEN=<generate-your-own-token>  # do not commit or print a real value
export OH_SESSION_API_KEY=<your-openhands-session-api-key>
export OH_AGENT_PROFILE_ID=<default-agent-profile-id>
npx tsx src/control-plane/main.ts   # or: npm run control-plane
```

```sh
# in another shell, once it logs "Control Plane listening on http://127.0.0.1:8787"
curl http://127.0.0.1:8787/health

curl -X POST http://127.0.0.1:8787/api/runs \
  -H "Authorization: Bearer $ORCHESTRATOR_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "orchestrator-canvas-control-plane-v1"}'

curl http://127.0.0.1:8787/api/runs/<runId>
```

Additional environment variables for the Control Plane (all optional except the token, all shared with the CLI's `OH_*` variables above for the underlying `AgentClient`/GitHub/workspace behavior):

- `ORCHESTRATOR_CONTROL_TOKEN` — **required**; the server refuses to start without it.
- `ORCHESTRATOR_TASK_ROOT` (defaults to `tasks/`) — allowlisted directory `POST /api/runs` resolves `taskId` against.
- `ORCHESTRATOR_RUN_STATE_DIR` (defaults to `.orchestrator/runs/`) — same `RunState` store format the CLI uses.
- `ORCHESTRATOR_CONTROL_STATE_DIR` (defaults to `.orchestrator/control-plane/runs/`) — the Control Plane's own run registry.
- `ORCHESTRATOR_CONTROL_HOST` (defaults to `127.0.0.1`).
- `ORCHESTRATOR_CONTROL_PORT` (defaults to `8787`).
