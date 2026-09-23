import { OpenHandsClient } from "./OpenHandsClient";
import { loadWorkflowTask } from "./taskLoader";
import {
  nextStateAfterReview,
  parseReviewerVerdict,
  type WorkflowState,
} from "./workflow";

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

async function runAgent(
  client: OpenHandsClient,
  workspace: string,
  message: string,
): Promise<string> {
  const conversation = await client.createConversation({
    workspace,
    agentProfileId: requiredEnv("OH_AGENT_PROFILE_ID"),
    message,
  });

  console.log(`Conversation: ${conversation.id}`);

  await client.waitUntilFinished(conversation.id, {
    pollIntervalMs: 1000,
    timeoutMs: 180_000,
  });

  return client.getFinalResponse(conversation.id);
}

async function main(): Promise<void> {
  const client = new OpenHandsClient(
    process.env.OH_BASE_URL ?? "http://localhost:8000",
    requiredEnv("OH_SESSION_API_KEY"),
  );

  const task = loadWorkflowTask(
    requiredEnv("WORKFLOW_TASK_FILE"),
  );

  const initialState =
    process.env.OH_INITIAL_STATE ?? "IMPLEMENTING";

  if (
    initialState !== "IMPLEMENTING" &&
    initialState !== "REVIEWING"
  ) {
    throw new Error(
      `Invalid OH_INITIAL_STATE: ${initialState}`,
    );
  }

  let state: WorkflowState = initialState;
  let implementationCycle = 0;
  let reviewerFeedback: string | null = null;

  const repository =
    `${task.repository.owner}/${task.repository.name}`;

  const acceptanceCriteria = task.acceptanceCriteria
    .map(
      (criterion, index) =>
        `${index + 1}. ${criterion}`,
    )
    .join("\n");

  console.log("================================");
  console.log(`Task: ${task.id}`);
  console.log(`Repository: ${repository}`);
  console.log(`PR: #${task.pullRequestNumber}`);
  console.log(`Branch: ${task.workingBranch}`);
  console.log("================================");

  while (state !== "DONE" && state !== "FAILED") {
    console.log("\n==============================");
    console.log(`State: ${state}`);
    console.log(
      `Implementation cycle: ${implementationCycle + 1}/${task.maxReviewCycles}`,
    );
    console.log("==============================\n");

    if (state === "IMPLEMENTING") {
      implementationCycle += 1;

      if (
        implementationCycle >
        task.maxReviewCycles
      ) {
        state = "FAILED";
        break;
      }

      const feedbackSection = reviewerFeedback
        ? `
El Reviewer anterior devolvió este feedback:

--- REVIEWER FEEDBACK ---
${reviewerFeedback}
--- END REVIEWER FEEDBACK ---

Debes atender específicamente ese feedback antes de devolver el trabajo a revisión.
`
        : `
No existe feedback previo del Reviewer.

Inspecciona el estado actual del Pull Request y determina qué falta para cumplir la tarea.
`;

      const implementationResponse = await runAgent(
        client,
        task.workspace,
        `
Actúa exclusivamente como Implementador.

TASK ID:
${task.id}

REPOSITORIO:
${repository}

PULL REQUEST:
#${task.pullRequestNumber}

RAMA BASE:
${task.baseBranch}

RAMA DE TRABAJO:
${task.workingBranch}

OBJETIVO:
${task.objective}

CRITERIOS DE ACEPTACIÓN:
${acceptanceCriteria}

${feedbackSection}

Antes de modificar código:
- verifica la rama actual;
- confirma que estás trabajando sobre ${task.workingBranch};
- inspecciona el Pull Request #${task.pullRequestNumber};
- inspecciona el estado actual del repositorio;
- determina qué cambios son necesarios para satisfacer el objetivo y todos los criterios de aceptación.

Si el trabajo ya cumple completamente:
- no hagas modificaciones innecesarias;
- no crees commits vacíos;
- no hagas push innecesario.

Si existen problemas o el Reviewer solicitó cambios:
- realiza únicamente los cambios necesarios;
- revisa cuidadosamente el diff;
- ejecuta las verificaciones razonables relacionadas con el cambio;
- crea un commit descriptivo;
- haz push a ${task.workingBranch}.

Nunca hagas merge.
Nunca abras otro Pull Request.
Nunca cambies la rama base.

Tu respuesta final debe incluir exactamente:

IMPLEMENTATION_RESULT: READY_FOR_REVIEW

Después puedes incluir un resumen breve de lo realizado.
`,
      );

      console.log(
        "--- Implementer response ---\n",
      );
      console.log(implementationResponse);

      if (
        !implementationResponse.includes(
          "IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
        )
      ) {
        throw new Error(
          "Implementer did not return IMPLEMENTATION_RESULT: READY_FOR_REVIEW",
        );
      }

      reviewerFeedback = null;
      state = "REVIEWING";
      continue;
    }

    if (state === "REVIEWING") {
      const reviewerResponse = await runAgent(
        client,
        task.workspace,
        `
Actúa exclusivamente como Reviewer.

TASK ID:
${task.id}

REPOSITORIO:
${repository}

PULL REQUEST:
#${task.pullRequestNumber}

RAMA BASE:
${task.baseBranch}

RAMA DE TRABAJO:
${task.workingBranch}

OBJETIVO:
${task.objective}

CRITERIOS DE ACEPTACIÓN:
${acceptanceCriteria}

Revisa el Pull Request contra el objetivo y TODOS los criterios de aceptación.

Reglas:
- trabaja en modo estrictamente read-only;
- inspecciona el estado real del Pull Request;
- usa el head actual del Pull Request;
- no modifiques archivos;
- no cambies ramas;
- no hagas commits;
- no hagas push;
- no hagas merge;
- no publiques reviews ni comentarios en GitHub.

Tu respuesta final DEBE contener exactamente uno de estos verdicts:

REVIEW_VERDICT: APPROVED

o

REVIEW_VERDICT: CHANGES_REQUESTED

Usa APPROVED únicamente si el Pull Request satisface completamente el objetivo y todos los criterios de aceptación.

Si utilizas CHANGES_REQUESTED, explica con precisión qué debe corregir el Implementador.
`,
      );

      console.log(
        "--- Reviewer response ---\n",
      );
      console.log(reviewerResponse);

      const verdict =
        parseReviewerVerdict(reviewerResponse);

      if (verdict === "CHANGES_REQUESTED") {
        reviewerFeedback = reviewerResponse;
      }

      state = nextStateAfterReview(verdict);

      console.log(`\nVerdict: ${verdict}`);
      console.log(`Next state: ${state}`);

      continue;
    }
  }

  console.log("\n==============================");
  console.log(`TASK: ${task.id}`);
  console.log(`WORKFLOW FINISHED: ${state}`);
  console.log("==============================");

  if (state === "FAILED") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

