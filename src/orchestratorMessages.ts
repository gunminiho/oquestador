import type { WorkflowTask } from "./task";

export function repositoryName(
  task: WorkflowTask,
): string {
  return `${task.repository.owner}/${task.repository.name}`;
}

export function formatAcceptanceCriteria(
  task: WorkflowTask,
): string {
  return task.acceptanceCriteria
    .map(
      (criterion, index) =>
        `${index + 1}. ${criterion}`,
    )
    .join("\n");
}

export function buildPreparationMessage(
  task: WorkflowTask,
): string {
  return `
Actúa exclusivamente como agente de preparación Git.

TASK ID:
${task.id}

REPOSITORIO:
${repositoryName(task)}

RAMA BASE:
${task.baseBranch}

RAMA DE TRABAJO:
${task.workingBranch}

El orquestador ya creó o recuperó un workspace aislado y ya se encargó de publicar la rama remota. Tu responsabilidad es únicamente validar de forma segura que el workspace está listo para implementación.

Procedimiento:
- inspecciona el estado Git actual;
- verifica que HEAD sea válido dentro del worktree aislado; el worktree puede estar en detached HEAD por diseño;
- verifica que el working tree esté limpio;
- ejecuta fetch de origin si es necesario para validar referencias;
- verifica que origin/${task.baseBranch} exista;
- no cambies de rama ni crees una rama local;
- no crees ramas;
- no hagas push;
- no modifiques archivos del proyecto;
- no implementes la tarea;
- no crees Pull Requests;
- no hagas merge;
- no hagas reset ni stash.

Si todas las precondiciones están satisfechas, tu respuesta final debe contener exactamente:

PREPARATION_RESULT: READY

Si alguna precondición segura no puede satisfacerse, NO fuerces cambios. Tu respuesta final debe contener exactamente:

PREPARATION_RESULT: BLOCKED
PREPARATION_REASON: <razón concreta en una sola línea>

Después puedes incluir un resumen breve.
`;
}

export function buildImplementationMessage(
  task: WorkflowTask,
  reviewerFeedback: string | null,
  pullRequestNumber: number | null,
): string {
  const feedbackSection =
    reviewerFeedback
      ? `
El Reviewer anterior devolvió este feedback:

--- REVIEWER FEEDBACK ---
${reviewerFeedback}
--- END REVIEWER FEEDBACK ---

Debes atender específicamente ese feedback antes de devolver el trabajo a revisión.
`
      : `
No existe feedback previo del Reviewer.

Inspecciona el estado actual del repositorio y determina qué falta para cumplir la tarea.
`;

  const pullRequestContext =
    pullRequestNumber !== null
      ? `
Ya existe el Pull Request #${pullRequestNumber}.

Trabaja sobre la misma rama y no abras otro Pull Request.
`
      : `
Todavía no existe Pull Request.

El orquestador publicará la rama y creará o reutilizará el Pull Request después de que termines.
`;

  return `
Actúa exclusivamente como Implementador.

TASK ID:
${task.id}

REPOSITORIO:
${repositoryName(task)}

PULL REQUEST:
${pullRequestContext}

RAMA BASE:
${task.baseBranch}

RAMA DE TRABAJO:
${task.workingBranch}

OBJETIVO:
${task.objective}

CRITERIOS DE ACEPTACIÓN:
${formatAcceptanceCriteria(task)}

${feedbackSection}

Antes de modificar código:
- verifica que estás dentro del workspace aislado correcto; el worktree puede estar en detached HEAD por diseño;
- inspecciona el estado actual del repositorio;
- determina qué cambios son necesarios para satisfacer el objetivo y todos los criterios.

Si el trabajo ya cumple completamente:
- no hagas modificaciones innecesarias;
- no crees commits vacíos.

Si existen cambios necesarios:
- realiza únicamente los cambios necesarios;
- revisa cuidadosamente el diff;
- ejecuta las verificaciones razonables relacionadas;
- crea un commit descriptivo local.

El orquestador se encarga de publicar la rama y de crear o reutilizar el Pull Request.
NO hagas git push.
NO ejecutes gh pr create.
NO hagas merge.
NO cambies la rama base.

Tu respuesta final debe incluir exactamente:

IMPLEMENTATION_RESULT: READY_FOR_REVIEW

Si conoces un Pull Request ya existente puedes incluir opcionalmente:

PULL_REQUEST_NUMBER: <número>

Después puedes incluir un resumen breve de lo realizado.
`;
}

export function buildReviewMessage(
  task: WorkflowTask,
  pullRequestNumber: number,
  headSha: string,
): string {
  return `
Actúa exclusivamente como Reviewer.

TASK ID:
${task.id}

REPOSITORIO:
${repositoryName(task)}

PULL REQUEST:
#${pullRequestNumber}

HEAD SHA BAJO REVISIÓN:
${headSha}

RAMA BASE:
${task.baseBranch}

RAMA DE TRABAJO:
${task.workingBranch}

OBJETIVO:
${task.objective}

CRITERIOS DE ACEPTACIÓN:
${formatAcceptanceCriteria(task)}

Revisa el Pull Request contra el objetivo y TODOS los criterios de aceptación.

Reglas:
- trabaja en modo estrictamente read-only;
- inspecciona el estado real del Pull Request;
- revisa exactamente el HEAD SHA indicado arriba;
- si GitHub muestra otro HEAD SHA, no apruebes la revisión;
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
`;
}
