export type ExecutionRole = "architect" | "implementer" | "reviewer";

export interface RequestedExecution {
  role: ExecutionRole;
  profileId?: string;
  profileAlias?: string;
  provider: string;
  model: string;
  effort: string;
  allowFallback: boolean;
}

export interface AvailableExecutionProfile {
  id: string;
  name?: string;
  aliases?: string[];
  provider: string;
  model: string;
  effort: string;
}

export interface ResolvedExecution {
  role: ExecutionRole;
  profileId: string;
  provider: string;
  model: string;
  effort: string;
  /** Only public profile identity metadata is retained; credentials are never read. */
  evidence: { matchedBy: "profileId" | "profileAlias" | "exactRoute"; profileName?: string };
}

export interface ResolutionFailure {
  blocked: true;
  code: "PROFILE_NOT_FOUND" | "ROUTE_MISMATCH" | "FALLBACK_UNAVAILABLE";
  message: string;
  requested: RequestedExecution;
}

export type ResolutionResult =
  | { blocked: false; resolved: ResolvedExecution }
  | ResolutionFailure;

export class ExecutionRouteResolver {
  constructor(private readonly profiles: readonly AvailableExecutionProfile[]) {
    for (const profile of profiles) validateProfile(profile);
  }

  resolve(requested: RequestedExecution): ResolutionResult {
    validateRequestedExecution(requested);
    const selected = requested.profileId !== undefined
      ? this.profiles.find((profile) => profile.id === requested.profileId)
      : requested.profileAlias !== undefined
        ? this.profiles.find((profile) => profile.name === requested.profileAlias || profile.aliases?.includes(requested.profileAlias!))
        : this.profiles.find((profile) => exact(profile, requested));
    if (selected && exact(selected, requested)) return { blocked: false, resolved: resolved(requested, selected, requested.profileId ? "profileId" : requested.profileAlias ? "profileAlias" : "exactRoute") };
    if (selected && !exact(selected, requested)) {
      if (!requested.allowFallback) return failure("ROUTE_MISMATCH", `Profile ${selected.id} does not exactly match requested provider/model/effort.`, requested);
      const fallback = this.profiles.find((profile) => exact(profile, requested));
      return fallback ? { blocked: false, resolved: resolved(requested, fallback, "exactRoute") } : failure("FALLBACK_UNAVAILABLE", "Fallback was declared but no exact provider/model/effort route is available.", requested);
    }
    if (requested.profileId || requested.profileAlias) return failure("PROFILE_NOT_FOUND", "Requested execution profile was not found.", requested);
    return failure("FALLBACK_UNAVAILABLE", "No exact execution route is available.", requested);
  }
}

function exact(profile: AvailableExecutionProfile, request: RequestedExecution): boolean { return profile.provider === request.provider && profile.model === request.model && profile.effort === request.effort; }
function resolved(request: RequestedExecution, profile: AvailableExecutionProfile, matchedBy: ResolvedExecution["evidence"]["matchedBy"]): ResolvedExecution { return { role: request.role, profileId: profile.id, provider: profile.provider, model: profile.model, effort: profile.effort, evidence: { matchedBy, ...(profile.name ? { profileName: profile.name } : {}) } }; }
function failure(code: ResolutionFailure["code"], message: string, requested: RequestedExecution): ResolutionFailure { return { blocked: true, code, message, requested }; }
function nonEmpty(value: unknown, field: string): asserts value is string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`); }
export function validateRequestedExecution(value: RequestedExecution): void { nonEmpty(value.role, "RequestedExecution.role"); if (value.role !== "architect" && value.role !== "implementer" && value.role !== "reviewer") throw new Error("RequestedExecution.role is invalid."); nonEmpty(value.provider, "RequestedExecution.provider"); nonEmpty(value.model, "RequestedExecution.model"); nonEmpty(value.effort, "RequestedExecution.effort"); if (typeof value.allowFallback !== "boolean") throw new Error("RequestedExecution.allowFallback must be boolean."); if (value.profileId !== undefined) nonEmpty(value.profileId, "RequestedExecution.profileId"); if (value.profileAlias !== undefined) nonEmpty(value.profileAlias, "RequestedExecution.profileAlias"); if (value.profileId && value.profileAlias) throw new Error("RequestedExecution may specify profileId or profileAlias, not both."); }
function validateProfile(value: AvailableExecutionProfile): void { nonEmpty(value.id, "AvailableExecutionProfile.id"); nonEmpty(value.provider, "AvailableExecutionProfile.provider"); nonEmpty(value.model, "AvailableExecutionProfile.model"); nonEmpty(value.effort, "AvailableExecutionProfile.effort"); }
