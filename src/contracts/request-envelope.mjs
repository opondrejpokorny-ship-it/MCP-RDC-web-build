import { GATED_TRANSITIONS } from "./boundary.mjs";

export const MUTATION_ENVELOPE_FIELDS = Object.freeze([
  "project_id",
  "operation_id",
  "operation_revision",
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
  "operation_revision",
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
const OPERATION_REVISION_RE = /^[1-9][0-9]{0,19}$/;
const BACKEND_TRANSITIONS = Object.freeze({
  website_change_accept: "accept",
  website_change_reject: "reject",
  website_release_prepare: "release_prepare",
  website_release_activate: "release_activate",
});

function nonEmptyString(value, max = 256) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactDataSnapshot(value, fields) {
  if (!plainObject(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== fields.length
    || ownKeys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) return null;
  const out = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) return null;
    out[field] = descriptor.value;
  }
  return Object.freeze(out);
}

function hasAuthorizationEvidenceShape(request, expectedTransition) {
  const expectedBackendTransition = BACKEND_TRANSITIONS[expectedTransition];
  if (!expectedBackendTransition) return false;
  const evidence = exactDataSnapshot(
    request.authorization_evidence,
    AUTHORIZATION_EVIDENCE_FIELDS,
  );
  if (!evidence) return false;
  if (!nonEmptyString(evidence.authorization_id)) return false;
  if (evidence.decision !== "approved") return false;
  if (evidence.transition !== expectedBackendTransition) return false;
  if (!nonEmptyString(evidence.issued_at) || !nonEmptyString(evidence.expires_at)) return false;
  const issuedAt = Date.parse(evidence.issued_at);
  const expiresAt = Date.parse(evidence.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return false;
  if (
    typeof evidence.operation_revision !== "string"
    || !OPERATION_REVISION_RE.test(evidence.operation_revision)
  ) return false;

  return (
    evidence.project_id === request.project_id
    && evidence.operation_id === request.operation_id
    && evidence.operation_revision === request.operation_revision
    && evidence.expected_workspace_digest === request.expected_workspace_digest
    && evidence.idempotency_key === request.idempotency_key
    && evidence.caller_class === request.caller_class
  );
}

export function hasMutationEnvelopeShape(value, { expectedTransition } = {}) {
  if (!GATED_TRANSITIONS.includes(expectedTransition)) return false;
  const request = exactDataSnapshot(value, MUTATION_ENVELOPE_FIELDS);
  if (!request) return false;
  if (!nonEmptyString(request.project_id)) return false;
  if (!nonEmptyString(request.operation_id)) return false;
  if (
    typeof request.operation_revision !== "string"
    || !OPERATION_REVISION_RE.test(request.operation_revision)
  ) return false;
  if (!DIGEST_RE.test(request.expected_workspace_digest || "")) return false;
  if (!nonEmptyString(request.idempotency_key)) return false;
  if (!CALLER_CLASSES.includes(request.caller_class)) return false;
  return hasAuthorizationEvidenceShape(request, expectedTransition);
}