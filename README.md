# oquestador

oquestador is a proof of concept for coordinating development agents through OpenHands. It keeps control of workspace isolation, workflow state, GitHub publication, review loops, recovery, and deterministic merge decisions while Implementer and Reviewer agents focus on their roles.

## Workflow

The normal workflow is:

```text
PREPARING -> IMPLEMENTING -> REVIEWING -> MERGING -> DONE
     |
     +-> BLOCKED
```

During `PREPARING`, an agent validates the isolated workspace. It returns exactly `PREPARATION_RESULT: READY` or `PREPARATION_RESULT: BLOCKED`. A blocked preparation is not treated as a workflow failure: `RunState` keeps the reason and a later run resumes from preparation.

During `IMPLEMENTING`, the agent edits and commits inside the task worktree. It does not push and does not create a Pull Request. The orchestrator publishes the exact worktree HEAD and creates or reuses the Pull Request.

During `REVIEWING`, the Reviewer inspects the real Pull Request HEAD and returns either `APPROVED` or `CHANGES_REQUESTED`. Requested changes return to `IMPLEMENTING` with no artificial cycle limit.

After `APPROVED`, `MERGING` verifies that the Pull Request HEAD still matches the reviewed SHA and performs the merge only for that approved revision.

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

These use bounded exponential backoff. Transient conversation 404s are also bounded.

If the retry budget is exhausted, the workflow records `failureKind: TRANSIENT` while preserving the active stage and conversation ID. Re-running the same task can resume that stage and the same deterministic conversation rather than creating a duplicate.

An actual OpenHands `execution_status=error` or `stuck` remains a terminal agent condition. It is recorded separately as `TERMINAL`; the orchestrator does not blindly retry semantic agent failures.

## RunState

RunState version 3 stores:

- workflow state and preparation attempt;
- implementation/review cycle information;
- Pull Request and reviewed/approved HEAD SHAs;
- active stage and deterministic conversation IDs;
- reviewer feedback;
- BLOCKED reason;
- failure kind/message;
- merge result.

Version 1 and version 2 states are migrated when read.

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

Start the orchestrator:

```sh
npx tsx src/orchestrator.ts
```

Useful environment variables include:

- `OH_BASE_URL`
- `OH_SESSION_API_KEY`
- `OH_AGENT_PROFILE_ID`
- `OH_AGENT_CONTAINER` (defaults to `openhands-canvas`)
- `OH_WORKTREE_ROOT` (defaults to `/projects/.orchestrator-worktrees`)
- `WORKFLOW_TASK_FILE`
