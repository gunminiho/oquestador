import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStateStore } from "../runState";
import type { WorkflowTask } from "../task";

import { RunManager } from "./runManager";
import { createControlPlaneServer } from "./server";
import { ControlPlaneStore } from "./store";
import {
  ControllableAgentClient,
  FakeGitHubClient,
  FakeWorkspaceManager,
  waitUntil,
} from "./testFakes";

const CONTROL_TOKEN = "test-control-token";

function writeTaskFixture(
  taskRoot: string,
  taskId: string,
): void {
  const task: WorkflowTask = {
    id: taskId,
    repository: {
      owner: "gunminiho",
      name: "oquestador-fixture",
    },
    workspace: "/tmp/fixture-workspace",
    baseBranch: "main",
    workingBranch: "agent/fake",
    objective: "Do the fixture thing.",
    acceptanceCriteria: ["It works."],
  };

  writeFileSync(
    join(taskRoot, `${taskId}.json`),
    JSON.stringify(task),
    "utf8",
  );
}

async function startTestServer(
  client = new ControllableAgentClient(),
) {
  const taskRoot = mkdtempSync(
    join(tmpdir(), "cp-http-tasks-"),
  );
  const runManager = new RunManager({
    taskRoot,
    runStateStore: new RunStateStore(
      mkdtempSync(
        join(
          tmpdir(),
          "cp-http-runstate-",
        ),
      ),
    ),
    controlPlaneStore:
      new ControlPlaneStore(
        mkdtempSync(
          join(
            tmpdir(),
            "cp-http-registry-",
          ),
        ),
      ),
    client,
    github: new FakeGitHubClient(),
    workspaceManager:
      new FakeWorkspaceManager(),
    defaultAgentProfileId:
      "default-profile",
  });

  const server = createControlPlaneServer({
    runManager,
    controlToken: CONTROL_TOKEN,
    host: "127.0.0.1",
    port: 0,
  });

  const { host, port } =
    await server.listen();
  const baseUrl = `http://${host}:${port}`;

  return { taskRoot, server, baseUrl, client };
}

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${CONTROL_TOKEN}`,
    "Content-Type": "application/json",
  };
}

test("createControlPlaneServer refuses to construct without a control token", () => {
  assert.throws(() =>
    createControlPlaneServer({
      runManager: new RunManager({
        taskRoot: ".",
        runStateStore:
          new RunStateStore(
            mkdtempSync(
              join(
                tmpdir(),
                "cp-http-runstate-",
              ),
            ),
          ),
        controlPlaneStore:
          new ControlPlaneStore(
            mkdtempSync(
              join(
                tmpdir(),
                "cp-http-registry-",
              ),
            ),
          ),
        client:
          new ControllableAgentClient(),
      }),
      controlToken: "",
    }),
  );
});

test("GET /health requires no authentication", async () => {
  const { server, baseUrl } =
    await startTestServer();

  try {
    const response = await fetch(
      `${baseUrl}/health`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
  } finally {
    await server.close();
  }
});

test("mutating routes reject missing and invalid auth", async () => {
  const { server, baseUrl } =
    await startTestServer();

  try {
    const missing = await fetch(
      `${baseUrl}/api/runs`,
      { method: "GET" },
    );
    assert.equal(missing.status, 401);

    const invalid = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "GET",
        headers: {
          Authorization:
            "Bearer wrong-token",
        },
      },
    );
    assert.equal(invalid.status, 403);
  } finally {
    await server.close();
  }
});

test("POST /api/runs validates body, rejects unknown/invalid taskId, and starts a valid run", async () => {
  const { server, baseUrl, taskRoot, client } =
    await startTestServer();
  writeTaskFixture(taskRoot, "task-a");

  try {
    const badBody = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "POST",
        headers: authHeaders(),
        body: "not json",
      },
    );
    assert.equal(badBody.status, 400);

    const traversal = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          taskId: "../outside",
        }),
      },
    );
    assert.equal(
      traversal.status,
      400,
    );

    const unknown = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          taskId: "does-not-exist",
        }),
      },
    );
    assert.equal(unknown.status, 404);

    const started = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          taskId: "task-a",
        }),
      },
    );
    assert.equal(started.status, 202);
    const summary = await started.json();
    assert.equal(
      summary.status,
      "RUNNING",
    );
    assert.equal(
      typeof summary.runId,
      "string",
    );

    const duplicate = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          taskId: "task-a",
        }),
      },
    );
    assert.equal(
      duplicate.status,
      409,
    );

    const getResponse = await fetch(
      `${baseUrl}/api/runs/${summary.runId}`,
      { headers: authHeaders() },
    );
    assert.equal(
      getResponse.status,
      200,
    );

    const listResponse = await fetch(
      `${baseUrl}/api/runs`,
      { headers: authHeaders() },
    );
    assert.equal(
      listResponse.status,
      200,
    );
    const listBody =
      await listResponse.json();
    assert.equal(
      listBody.runs.length,
      1,
    );

    const missingRun = await fetch(
      `${baseUrl}/api/runs/does-not-exist`,
      { headers: authHeaders() },
    );
    assert.equal(
      missingRun.status,
      404,
    );

    // Drain the fake conversations so the process can shut down cleanly.
    await waitUntil(() =>
      client.hasPending(),
    );
    client.finishNext(
      "PREPARATION_RESULT: READY",
    );
    await waitUntil(() =>
      client.hasPending(),
    );
    client.finishNext(
      [
        "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
        "PULL_REQUEST_NUMBER: 1",
      ].join("\n"),
    );
    await waitUntil(() =>
      client.hasPending(),
    );
    client.finishNext(
      "REVIEW_VERDICT: APPROVED",
    );
  } finally {
    await server.close();
  }
});

test("pause/resume/cancel respond 202 and unknown runId responds 404", async () => {
  const { server, baseUrl, taskRoot, client } =
    await startTestServer();
  writeTaskFixture(taskRoot, "task-a");

  try {
    const started = await fetch(
      `${baseUrl}/api/runs`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          taskId: "task-a",
        }),
      },
    );
    const summary = await started.json();

    await waitUntil(() =>
      client.hasPending(),
    );

    const pause = await fetch(
      `${baseUrl}/api/runs/${summary.runId}/pause`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    assert.equal(pause.status, 202);
    const pauseBody = await pause.json();
    assert.equal(
      pauseBody.status,
      "PAUSE_REQUESTED",
    );

    const missingAction = await fetch(
      `${baseUrl}/api/runs/does-not-exist/pause`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    assert.equal(
      missingAction.status,
      404,
    );

    client.finishNext(
      "PREPARATION_RESULT: READY",
    );

    await waitUntil(async () => {
      const check = await fetch(
        `${baseUrl}/api/runs/${summary.runId}`,
        { headers: authHeaders() },
      );
      const body = await check.json();
      return body.status === "PAUSED";
    });

    const resume = await fetch(
      `${baseUrl}/api/runs/${summary.runId}/resume`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    assert.equal(resume.status, 202);

    await waitUntil(() =>
      client.hasPending(),
    );
    client.finishNext(
      [
        "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
        "PULL_REQUEST_NUMBER: 1",
      ].join("\n"),
    );
    await waitUntil(() =>
      client.hasPending(),
    );

    const cancel = await fetch(
      `${baseUrl}/api/runs/${summary.runId}/cancel`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    assert.equal(cancel.status, 202);

    client.finishNext(
      "REVIEW_VERDICT: APPROVED",
    );

    await waitUntil(async () => {
      const check = await fetch(
        `${baseUrl}/api/runs/${summary.runId}`,
        { headers: authHeaders() },
      );
      const body = await check.json();
      return body.status === "CANCELLED";
    });
  } finally {
    await server.close();
  }
});

test("after close(), POST /api/runs responds 503 and refuses new runs", async () => {
  const { server, baseUrl, taskRoot } =
    await startTestServer();
  writeTaskFixture(taskRoot, "task-a");

  await server.close();

  await assert.rejects(
    fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        taskId: "task-a",
      }),
    }),
  );
});

test("responses are JSON and never include the control token", async () => {
  const { server, baseUrl } =
    await startTestServer();

  try {
    const response = await fetch(
      `${baseUrl}/api/runs`,
      { headers: authHeaders() },
    );
    const text = await response.text();
    assert.doesNotMatch(
      text,
      new RegExp(CONTROL_TOKEN),
    );
    assert.equal(
      response.headers.get(
        "content-type",
      ),
      "application/json; charset=utf-8",
    );
  } finally {
    await server.close();
  }
});
