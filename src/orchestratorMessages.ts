import type { WorkflowTask } from "./task";

export function repositoryName(task: WorkflowTask): string {
  return `${task.repository.owner}/${task.repository.name}`;
}

export function formatAcceptanceCriteria(
  task: WorkflowTask,
): string {
  return task.acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
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
`;
}

export function buildImplementationMessage(
  task: WorkflowTask,
  reviewerFeedback: string | null,
  pullRequestNumber: number | null,
): string {
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
    pullRequestNumber !== null
      ? `
Ya existe el Pull Request #${pullRequestNumber}.

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
