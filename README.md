# oquestador

oquestador is a proof of concept for coordinating development agents through OpenHands. It drives an implementation workflow across separate Implementer and Reviewer agents, while the orchestrator keeps control of state transitions and merge decisions.

## Current workflow

The workflow moves through these states:

```text
PREPARING -> IMPLEMENTING -> REVIEWING -> MERGING -> DONE
```

During `PREPARING`, the task is prepared for implementation. During `IMPLEMENTING`, the Implementer makes the requested change and opens or updates a pull request. During `REVIEWING`, the Reviewer inspects the pull request and returns either `APPROVED` or `CHANGES_REQUESTED`.

If the Reviewer returns `CHANGES_REQUESTED`, the workflow goes back to `IMPLEMENTING`. There is no artificial limit on review cycles; the loop continues until the pull request is approved or the workflow fails.

The Implementer and Reviewer agents never run the merge directly. After `APPROVED`, the orchestrator enters `MERGING`, verifies that the approved HEAD SHA is still the pull request HEAD, and performs the merge deterministically only for that approved revision.

`RunState` stores workflow progress, conversation IDs, review metadata, approved SHAs, and merge results so interrupted workflows can resume without starting over.

## Run the POC locally

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
npx tsc --noEmit
```

Start the orchestrator:

```sh
npx tsx src/orchestrator.ts
```
