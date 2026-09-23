import { OpenHandsClient } from "./OpenHandsClient";

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

  console.log("Starting OpenHands conversation...");

  const conversation = await client.createConversation({
    workspace: process.env.OH_WORKSPACE ?? "/projects/Credit_Master",
    agentProfileId: requiredEnv("OH_AGENT_PROFILE_ID"),
    message:
      "Trabaja en modo estrictamente read-only. No modifiques archivos, no instales dependencias, no hagas commits ni push. Indica únicamente el nombre del proyecto, la rama Git actual y el framework principal.",
  });

  console.log(`Conversation: ${conversation.id}`);

  const finished = await client.waitUntilFinished(conversation.id, {
    pollIntervalMs: 1000,
    timeoutMs: 180_000,
  });

  console.log(`Status: ${finished.execution_status}`);

  const finalResponse = await client.getFinalResponse(conversation.id);

  console.log("\n--- Agent response ---\n");
  console.log(finalResponse);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
