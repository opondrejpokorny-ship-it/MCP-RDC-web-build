import { GATED_TRANSITIONS } from "./boundary.mjs";

export const MUTATION_ENVELOPE_FIELDS = Object.freeze([
  "project_id",
  "operation_id",
  "expected_workspace_digest",
  "idempotency_key",
  "caller_class",
  "authorization_evidence",
]);

export const AUTHORIZATION_EVIDENCE_FIELDS = Object.freeze([
  "authorization_id",
  "decision",
  "transition",
  "project_id",
  "operation_id",
  "expected_workspace_digest",
  "idempotency_key",
  "caller_class",
  "issued_at",
  "expires_at",
]);

export const CALLER_CLASSES = Object.freeze([
  "model_orchestrator",
  "human_review_surface",
  "trusted_control_plane",
]);

const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;

function nonEmptyString(value, max = 256) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function hasAuthorizationEvidenceShape(request, expectedTransition) {
  const evidence = request.authorization_evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  if (!AUTHORIZATION_EVIDENCE_FIELDS.every((field) => Object.hasOwn(evidence, field))) return false;
  if (!nonEmptyString(evidence.authorization_id)) return false;
  if (evidence.decision !== "approved") return false;
  if (!GATED_TRANSITIONS.includes(expectedTransition)) return false;
  if (evidence.transition !== expectedTransition) return false;
  if (!nonEmptyString(evidence.issued_at) || !nonEmptyString(evidence.expires_at)) return false;
  const issuedAt = Date.parse(evidence.issued_at);
  const expiresAt = Date.parse(evidence.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return false;

  return (
    evidence.project_id === request.project_id
    && evidence.operation_id === request.operation_id
    && evidence.expected_workspace_digest === request.expected_workspace_digest
    && evidence.idempotency_key === request.idempotency_key
    && evidence.caller_class === request.caller_class
  );
}

export function hasMutationEnvelopeShape(value, { expectedTransition } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!GATED_TRANSITIONS.includes(expectedTransition)) return false;
  if (!MUTATION_ENVELOPE_FIELDS.every((field) => Object.hasOwn(value, field))) return false;
  if (!nonEmptyString(value.project_id)) return false;
  if (!nonEmptyString(value.operation_id)) return false;
  if (!DIGEST_RE.test(value.expected_workspace_digest || "")) return false;
  if (!nonEmptyString(value.idempotency_key)) return false;
  if (!CALLER_CLASSES.includes(value.caller_class)) return false;
  return hasAuthorizationEvidenceShape(value, expectedTransition);
}
