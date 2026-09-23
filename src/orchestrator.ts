import { OpenHandsClient } from "./OpenHandsClient";
import { loadWorkflowTask } from "./taskLoader";
import {
  nextStateAfterReview,
  parseImplementationResult,
  parsePreparationResult,
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

  const defaultInitialState: WorkflowState =
    task.pullRequestNumber === undefined
      ? "PREPARING"
      : "IMPLEMENTING";

  const requestedInitialState =
    process.env.OH_INITIAL_STATE;

  if (
    requestedInitialState !== undefined &&
    requestedInitialState !== "PREPARING" &&
    requestedInitialState !== "IMPLEMENTING" &&
    requestedInitialState !== "REVIEWING"
  ) {
    throw new Error(
      `Invalid OH_INITIAL_STATE: ${requestedInitialState}`,
    );
  }

  let state: WorkflowState =
    requestedInitialState ?? defaultInitialState;
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
  console.log(
    task.pullRequestNumber !== undefined
      ? `PR: #${task.pullRequestNumber}`
      : "PR: pending creation",
  );
  console.log(`Branch: ${task.workingBranch}`);
  console.log("================================");

  while (state !== "DONE" && state !== "FAILED") {
    console.log("\n==============================");
    console.log(`State: ${state}`);
    console.log(
      `Implementation cycle: ${implementationCycle + 1}/${task.maxReviewCycles}`,
    );
    console.log("==============================\n");

    if (state === "PREPARING") {
      const preparationResponse = await runAgent(
        client,
        task.workspace,
        `
Actúa exclusivamente como agente de preparación Git.

TASK ID:
${task.id}

REPOSITORIO:
${repository}

RAMA BASE:
${task.baseBranch}

RAMA DE TRABAJO:
${task.workingBranch}

Tu única responsabilidad es dejar la rama de trabajo preparada.

Procedimiento:
- inspecciona el estado Git actual;
- exige que el working tree esté limpio antes de continuar;
- ejecuta fetch del remoto;
- verifica que origin/${task.baseBranch} exista;
- comprueba si ${task.workingBranch} ya existe localmente o en origin;
- si ya existe, cámbiate a esa rama sin sobrescribir ni resetear trabajo existente;
- si no existe, créala desde origin/${task.baseBranch};
- publica la nueva rama en origin si todavía no existe remotamente;
- verifica al final que HEAD esté en ${task.workingBranch}.

No modifiques archivos del proyecto.
No implementes la tarea.
No crees Pull Requests.
No hagas merge.
No borres ni resetees una rama existente.

Si la rama queda correctamente preparada, tu respuesta final debe contener exactamente:

PREPARATION_RESULT: READY

Después puedes incluir un resumen breve.
`,
      );

      console.log("--- Preparation response ---\n");
      console.log(preparationResponse);

      parsePreparationResult(preparationResponse);

      state = "IMPLEMENTING";

      console.log("\nPreparation: READY");
      console.log(`Next state: ${state}`);

      continue;
    }

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

      const pullRequestContext =
        task.pullRequestNumber !== undefined
          ? `
Ya existe el Pull Request #${task.pullRequestNumber}.

Debes trabajar sobre ese Pull Request.
No abras otro Pull Request.
`
          : `
Todavía NO existe Pull Request para esta tarea.

Después de completar los cambios:
- verifica el diff;
- ejecuta las pruebas razonables relacionadas;
- crea un commit descriptivo;
- haz push a ${task.workingBranch};
- comprueba si ya existe un Pull Request abierto desde ${task.workingBranch} hacia ${task.baseBranch};
- si existe, reutilízalo;
- si no existe, crea uno con gh pr create;
- la base debe ser ${task.baseBranch};
- el head debe ser ${task.workingBranch};
- usa un título y descripción que reflejen la tarea;
- NO hagas merge.

Tu respuesta final deberá incluir también:

PULL_REQUEST_NUMBER: <número real del PR>
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
${pullRequestContext}

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
- si existe un Pull Request, inspecciónalo antes de modificar código;
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

      const implementationResult =
        parseImplementationResult(
          implementationResponse,
        );

      if (
        implementationResult.pullRequestNumber !==
        undefined
      ) {
        task.pullRequestNumber =
          implementationResult.pullRequestNumber;
      }

      if (task.pullRequestNumber === undefined) {
        throw new Error(
          "Implementation finished without a Pull Request number.",
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
