import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionRouteResolver } from "./executionRouting";
import { requestedExecutionFor, validateProgramManifest } from "./programManifest";

const manifest = () => validateProgramManifest({ version: 1, programId: "p", repositories: [{ id: "r", owner: "o", name: "n" }], milestones: [{ id: "one", repositoryId: "r", routing: { reviewer: { profileId: "review", provider: "openai", model: "gpt-5.5", effort: "high" } } }], routing: { defaults: { architect: { profileAlias: "architecture", provider: "openai", model: "gpt-5.5", effort: "high" }, implementer: { profileId: "implement", provider: "openai", model: "gpt-5.5", effort: "high" }, reviewer: { profileId: "review-default", provider: "openai", model: "gpt-5.5", effort: "medium" } } } });
const profiles = [{ id: "implement", provider: "openai", model: "gpt-5.5", effort: "high" }, { id: "review", provider: "openai", model: "gpt-5.5", effort: "high" }, { id: "wrong", provider: "openai", model: "gpt-5.5", effort: "medium" }];

test("manifest keeps model and effort separate and applies milestone role override", () => {
  const m = manifest(); const implementation = requestedExecutionFor(m, "one", "implementer"); const review = requestedExecutionFor(m, "one", "reviewer");
  assert.equal(implementation.model, "gpt-5.5"); assert.equal(implementation.effort, "high"); assert.equal(review.profileId, "review"); assert.equal(review.effort, "high"); assert.equal(review.allowFallback, false);
});
test("resolver requires exact profile model and effort even with a valid id", () => {
  const result = new ExecutionRouteResolver(profiles).resolve({ role: "implementer", profileId: "wrong", provider: "openai", model: "gpt-5.5", effort: "high", allowFallback: false });
  assert.equal(result.blocked, true); if (result.blocked) assert.equal(result.code, "ROUTE_MISMATCH");
});
test("resolver resolves exact profile and only uses fallback when explicitly declared", () => {
  const resolver = new ExecutionRouteResolver(profiles);
  const exact = resolver.resolve({ role: "reviewer", profileId: "review", provider: "openai", model: "gpt-5.5", effort: "high", allowFallback: false });
  assert.equal(exact.blocked, false); if (!exact.blocked) assert.equal(exact.resolved.profileId, "review");
  const fallback = resolver.resolve({ role: "reviewer", profileId: "wrong", provider: "openai", model: "gpt-5.5", effort: "high", allowFallback: true });
  assert.equal(fallback.blocked, false); if (!fallback.blocked) assert.equal(fallback.resolved.profileId, "implement");
});
test("manifest rejects incomplete routes and unknown fields", () => {
  assert.throws(() => validateProgramManifest({ version: 1, programId: "p", repositories: [], milestones: [], routing: { defaults: { implementer: { provider: "openai", model: "x" } } } }));
  assert.throws(() => validateProgramManifest({ version: 1, programId: "p", repositories: [], milestones: [], routing: { defaults: {}, extra: true } }));
});
