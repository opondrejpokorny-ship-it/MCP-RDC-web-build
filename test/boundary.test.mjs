import test from "node:test";
import assert from "node:assert/strict";
import {
  WEBSITE_TOOL_NAMES,
  WEBSITE_MCP_DOES_NOT_OWN,
  GATED_TRANSITIONS,
  PUBLICATION_SEQUENCE,
  MUTATION_ENVELOPE_FIELDS,
  WEBSITE_TOOLSET_STATUS,
  hasMutationEnvelopeShape,
} from "../src/index.mjs";

test("website tool names are unique", () => {
  assert.equal(new Set(WEBSITE_TOOL_NAMES).size, WEBSITE_TOOL_NAMES.length);
});

test("phase 1 exposes static_web only", () => {
  assert.deepEqual(WEBSITE_TOOLSET_STATUS.supported_project_types, ["static_web"]);
  assert.equal(WEBSITE_TOOLSET_STATUS.executable_tools, false);
});

test("accept, release prepare, and release activate remain distinct", () => {
  assert.deepEqual(PUBLICATION_SEQUENCE, [
    "website_change_accept",
    "website_release_prepare",
    "website_release_activate",
  ]);
  assert.equal(new Set(PUBLICATION_SEQUENCE).size, 3);
});

test("gated transitions include reject but no accept-and-publish shortcut", () => {
  assert.ok(GATED_TRANSITIONS.includes("website_change_reject"));
  assert.ok(!WEBSITE_TOOL_NAMES.includes("website_accept_and_publish"));
});

test("MCP layer does not own backend or stock RDC authority", () => {
  assert.ok(WEBSITE_MCP_DOES_NOT_OWN.includes("managed_project_state"));
  assert.ok(WEBSITE_MCP_DOES_NOT_OWN.includes("review_decision_authority"));
  assert.ok(WEBSITE_MCP_DOES_NOT_OWN.includes("stock_rdc_execution_primitives"));
});

test("future mutation envelope requires exact non-empty identity shape", () => {
  assert.deepEqual(MUTATION_ENVELOPE_FIELDS, [
    "project_id",
    "operation_id",
    "expected_workspace_digest",
    "idempotency_key",
    "caller_class",
    "authorization_evidence",
  ]);
  const complete = {
    project_id: "project-static-1",
    operation_id: "operation-1",
    expected_workspace_digest: "a".repeat(64),
    idempotency_key: "idem-12345678",
    caller_class: "model_orchestrator",
    authorization_evidence: {
      authorization_id: "approval-1",
      decision: "approved",
      transition: "website_change_accept",
      project_id: "project-static-1",
      operation_id: "operation-1",
      expected_workspace_digest: "a".repeat(64),
      idempotency_key: "idem-12345678",
      caller_class: "model_orchestrator",
      issued_at: "2026-09-26T19:59:00.000Z",
      expires_at: "2026-09-26T20:05:00.000Z",
    },
  };
  const gate = { expectedTransition: "website_change_accept" };
  assert.equal(hasMutationEnvelopeShape(complete, gate), true);
  assert.equal(hasMutationEnvelopeShape(complete), false);
  assert.equal(hasMutationEnvelopeShape(complete, { expectedTransition: "website_unknown" }), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, project_id: "" }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, project_id: "   " }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, operation_id: "\t" }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, expected_workspace_digest: "bad" }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, caller_class: "model_claims_admin" }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, authorization_evidence: null }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, authorization_evidence: {} }, gate), false);
  assert.equal(hasMutationEnvelopeShape({ ...complete, authorization_evidence: { authorization_id: "   " } }, gate), false);
  assert.equal(hasMutationEnvelopeShape({
    ...complete,
    authorization_evidence: { ...complete.authorization_evidence, decision: "denied" },
  }, gate), false);
  assert.equal(hasMutationEnvelopeShape({
    ...complete,
    authorization_evidence: { ...complete.authorization_evidence, transition: "website_release_activate" },
  }, gate), false);
});
