import {
  AuthenticationError,
  NetworkError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  RefusedError,
  ServerError,
  ValidationError,
} from "@seolyticize/sdk";
import { UsageError } from "./args.js";

/**
 * Exit codes a script can branch on.
 *
 * Stable and documented in --help and the README: a script that retries on 8
 * and pages somebody on 3 depends on these never being renumbered. Everything
 * unexpected is 1, so a new failure mode cannot masquerade as a known one.
 */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  auth: 3,
  permission: 4,
  notFound: 5,
  invalidInput: 6,
  refused: 7,
  rateLimited: 8,
  unavailable: 9,
} as const;

export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT.usage;
  if (error instanceof AuthenticationError) return EXIT.auth;
  if (error instanceof PermissionError) return EXIT.permission;
  if (error instanceof NotFoundError) return EXIT.notFound;
  if (error instanceof ValidationError) return EXIT.invalidInput;
  if (error instanceof RefusedError) return EXIT.refused;
  if (error instanceof RateLimitError) return EXIT.rateLimited;
  if (error instanceof ServerError || error instanceof NetworkError) {
    return EXIT.unavailable;
  }
  return EXIT.unexpected;
}

export const EXIT_HELP = `Exit codes:
  0  success
  1  unexpected error
  2  usage error (bad command, option or JSON)
  3  authentication failed (missing, unknown or revoked key)
  4  not permitted (role or client scope)
  5  not found (no such tool for this key)
  6  invalid input (did not match the tool's schema)
  7  refused (a well-formed request the product declined)
  8  rate limited (retries exhausted)
  9  server error or network failure`;
