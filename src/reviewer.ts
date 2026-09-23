import { OpenHandsClient } from "./OpenHandsClient";
import {
  nextStateAfterReview,
  parseReviewerVerdict,
} from "./workflow";

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

async function main(): Promise<void> {
  const client = new OpenHandsClient(
    process.env.OH_BASE_URL ?? "http://localhost:8000",
    requiredEnv("OH_SESSION_API_KEY"),
  );

  console.log("State: REVIEWING");

  const conversation = await client.createConversation({
    workspace: process.env.OH_WORKSPACE ?? "/projects/Credit_Master",
    agentProfileId: requiredEnv("OH_AGENT_PROFILE_ID"),
    message: `
Actúa exclusivamente como Reviewer.

Revisa el Pull Request #1 del repositorio gunminiho/credit-master usando GitHub CLI o herramientas de solo lectura.

Criterio esperado:
AGENT_WRITE_TEST.md debe contener únicamente:

OpenHands Codex write test OK

Reglas:
- modo estrictamente read-only;
- no modifiques archivos;
- no cambies ramas;
- no hagas commits;
- no hagas push;
- no hagas merge;
- no publiques ninguna review ni comentario en GitHub durante esta prueba.

Tu respuesta final DEBE contener exactamente uno de estos verdicts en una línea independiente:

REVIEW_VERDICT: APPROVED

o

REVIEW_VERDICT: CHANGES_REQUESTED

Después del verdict puedes explicar brevemente el motivo.
`,
  });

  console.log(`Reviewer conversation: ${conversation.id}`);

  await client.waitUntilFinished(conversation.id, {
    pollIntervalMs: 1000,
  });

  const response = await client.getFinalResponse(conversation.id);

  console.log("\n--- Reviewer response ---\n");
  console.log(response);

  const verdict = parseReviewerVerdict(response);
  const nextState = nextStateAfterReview(verdict);

  console.log("\n--- Orchestrator decision ---");
  console.log(`Verdict: ${verdict}`);
  console.log(`Next state: ${nextState}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
