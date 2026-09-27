import { timingSafeEqual } from "node:crypto";

const BEARER_PATTERN = /^Bearer (.+)$/;

export type AuthResult =
  | "OK"
  | "MISSING"
  | "INVALID";

/**
 * Checks an `Authorization: Bearer <token>` header against the configured
 * control token using a constant-time comparison so response timing cannot
 * leak how many leading characters matched.
 */
export function checkControlToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): AuthResult {
  if (
    authorizationHeader === undefined ||
    authorizationHeader.trim() === ""
  ) {
    return "MISSING";
  }

  const match = BEARER_PATTERN.exec(
    authorizationHeader,
  );

  if (match === null) {
    return "MISSING";
  }

  const provided = Buffer.from(
    match[1] ?? "",
    "utf8",
  );
  const expected = Buffer.from(
    expectedToken,
    "utf8",
  );

  if (provided.length !== expected.length) {
    // Still run a constant-time comparison of matching length so a length
    // mismatch does not short-circuit faster than a content mismatch.
    timingSafeEqual(
      Buffer.alloc(expected.length),
      expected,
    );

    return "INVALID";
  }

  return timingSafeEqual(provided, expected)
    ? "OK"
    : "INVALID";
}
