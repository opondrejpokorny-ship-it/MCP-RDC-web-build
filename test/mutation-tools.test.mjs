import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORIZATION_EVIDENCE_FIELDS,
  EXECUTABLE_WEBSITE_TOOL_NAMES,
  MUTATION_ENVELOPE_FIELDS,
  createInProcessStaticBackendAdapter,
  createStaticWebsiteToolset,
} from "../src/index.mjs";

const BASELINE = "a".repeat(64);
const TARGET = "b".repeat(64);
const PLAN = "c".repeat(64);
const PREPARED_ID = "change-" + "p".repeat(32);
const OPERATION_ID = "operation-" + "o".repeat(32);
const APPROVAL_ID = "approvalref-" + "r".repeat(32);

function project(overrides = {}) {
  return {
    project_id: "site-1",
    project_type: "static_web",
    workflow_state: "accepted",
    current_workspace_digest: BASELINE,
    accepted_workspace_digest: BASELINE,
    accepted_snapshot_id: "snapshot-" + "s".repeat(32),
    active_operation_id: "operation-bootstrap",
    active_operation_revision: "1",
    operation_identity_status: "bound",
    ready_release_id: null,
    active_release_id: null,
    pending_external_transition: null,
    ...overrides,
  };
}

function prepared(overrides = {}) {
  return {
    ok: true,
    state: "prepared",
    project_id: "site-1",
    prepared_change_id: PREPARED_ID,
    operation_id: OPERATION_ID,
    operation_revision: null,
    baseline_workspace_digest: BASELINE,
    target_workspace_digest: TARGET,
    plan_digest: PLAN,
    ...overrides,
  };
}

function applied(overrides = {}) {
  return {
    ...prepared(),
    state: "applied",
    operation_revision: "2",
    workspace_digest: TARGET,
    ...overrides,
  };
}

function makeBackend({
  prepareImpl = null,
  applyImpl = null,
  acceptImpl = null,
  rejectImpl = null,
} = {}) {
  const calls = [];
  let current = project();
  const backend = {
    calls,
    setProject(next) {
      current = next;
    },
    getProject(projectId) {
      calls.push(["getProject", projectId]);
      return { ...current, project_id: projectId };
    },
    listWorkspaceFiles() {
      return [];
    },
    validateWorkspace() {
      return {
        ok: true,
        project_id: current.project_id,
        workspace_digest: current.current_workspace_digest,
        findings: [],
      };
    },
    async startDevelopmentPreview() {
      throw new Error("not-used");
    },
  };
  if (prepareImpl) {
    backend.prepareChange = async (request) => {
      calls.push(["prepareChange", structuredClone(request)]);
      return prepareImpl(request);
    };
  }
  if (applyImpl) {
    backend.applyPreparedChange = async (request) => {
      calls.push(["applyPreparedChange", structuredClone(request)]);
      const result = await applyImpl(request);
      if (result?.ok === true && result.state === "applied") {
        current = project({
          workflow_state: "review_required",
          current_workspace_digest: result.workspace_digest,
          active_operation_id: result.operation_id,
          active_operation_revision: result.operation_revision,
          operation_identity_status: "bound",
        });
      }
      return result;
    };
  }
  if (acceptImpl) {
    backend.acceptChange = async (request) => {
      calls.push(["acceptChange", structuredClone(request)]);
      const result = await acceptImpl(request);
      if (result?.ok === true) current = result.state;
      return result;
    };
  }
  if (rejectImpl) {
    backend.rejectChange = async (request) => {
      calls.push(["rejectChange", structuredClone(request)]);
      const result = await rejectImpl(request);
      if (result?.ok === true) current = result.state;
      return result;
    };
  }
  return backend;
}

function operations(content = "<h1>B</h1>\n") {
  return [
    { type: "write", path: "index.html", content },
    { type: "delete", path: "old.css" },
  ];
}

function approvalResolver({ mismatch = null, throwError = false } = {}) {
  const calls = [];
  return {
    calls,
    async resolveApproval(request) {
      calls.push(structuredClone(request));
      if (throwError) throw new Error("secret approval provider detail");
      return {
        authorization_id: "authorization-" + "h".repeat(32),
        decision: mismatch === "decision" ? "denied" : "approved",
        transition: mismatch === "transition" ? "release_activate" : request.backend_transition,
        project_id: mismatch === "project_id" ? "site-foreign" : request.project_id,
        operation_id: mismatch === "operation_id" ? "operation-foreign" : request.operation_id,
        operation_revision: mismatch === "operation_revision" ? "999" : request.operation_revision,
        expected_workspace_digest: mismatch === "digest" ? BASELINE : request.expected_workspace_digest,
        idempotency_key: mismatch === "idempotency" ? "foreign-idem" : request.idempotency_key,
        caller_class: mismatch === "caller" ? "trusted_control_plane" : request.caller_class,
        issued_at: "2026-10-03T21:00:00.000Z",
        expires_at: "2026-10-03T23:59:00.000Z",
      };
    },
  };
}

test("mutation envelope contracts include immutable operation revision binding", () => {
  assert.ok(MUTATION_ENVELOPE_FIELDS.includes("operation_revision"));
  assert.ok(AUTHORIZATION_EVIDENCE_FIELDS.includes("operation_revision"));
});

test("prepare/apply are visible only with authoritative change composition; accept/reject also require trusted approvals", async () => {
  for (const name of [
    "website_change_prepare",
    "website_change_apply",
    "website_change_reject",
    "website_change_accept",
  ]) {
    assert.ok(EXECUTABLE_WEBSITE_TOOL_NAMES.includes(name));
  }

  const base = createStaticWebsiteToolset({ backend: makeBackend() });
  for (const name of [
    "website_change_prepare",
    "website_change_apply",
    "website_change_reject",
    "website_change_accept",
  ]) {
    assert.equal(base.tools.some((tool) => tool.name === name), false);
  }

  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
    acceptImpl: async () => ({ ok: true, transition: "accept", authorization_id: "x", state: project() }),
    rejectImpl: async () => ({ ok: true, transition: "reject", authorization_id: "x", state: project() }),
  });
  const mutationOnly = createStaticWebsiteToolset({ backend });
  assert.equal(mutationOnly.tools.some((tool) => tool.name === "website_change_prepare"), true);
  assert.equal(mutationOnly.tools.some((tool) => tool.name === "website_change_apply"), true);
  assert.equal(mutationOnly.tools.some((tool) => tool.name === "website_change_accept"), false);
  assert.equal(mutationOnly.tools.some((tool) => tool.name === "website_change_reject"), false);

  const approvals = approvalResolver();
  const full = createStaticWebsiteToolset({ backend, approvals });
  assert.equal(full.tools.some((tool) => tool.name === "website_change_accept"), true);
  assert.equal(full.tools.some((tool) => tool.name === "website_change_reject"), true);
  assert.equal(full.status.mutation_composed, true);
  assert.equal(full.status.review_decision_composed, true);
});

test("prepare schema is closed, bounded, and model cannot inject transaction authority", async () => {
  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const tool = toolset.tools.find((entry) => entry.name === "website_change_prepare");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, [
    "project_id",
    "expected_workspace_digest",
    "operations",
  ]);

  const invalid = [
    { project_id: "site-1", expected_workspace_digest: BASELINE, operations: operations(), idempotency_key: "model" },
    { project_id: "site-1", expected_workspace_digest: BASELINE, operations: operations(), caller_class: "trusted_control_plane" },
    { project_id: "site-1", expected_workspace_digest: BASELINE, operations: operations(), authorization_evidence: {} },
    { project_id: "site-1", expected_workspace_digest: BASELINE, operations: [{ type: "write", path: "../escape", content: "x" }] },
    { project_id: "site-1", expected_workspace_digest: BASELINE, operations: [{ type: "write", path: "index.html", content: "x", absolute_path: "C:\\secret" }] },
    { project_id: "site-1", expected_workspace_digest: BASELINE, operations: [] },
  ];
  for (const request of invalid) {
    assert.deepEqual(
      await toolset.callTool("website_change_prepare", request),
      { ok: false, error_code: "REQUEST_INVALID" },
    );
  }
  assert.equal(backend.calls.filter(([name]) => name === "prepareChange").length, 0);
});

test("prepare derives deterministic internal idempotency and returns metadata only", async () => {
  const backend = makeBackend({
    prepareImpl: async () => ({
      ...prepared(),
      operations: operations(),
      secret_internal: "must-not-leak",
    }),
    applyImpl: async () => applied(),
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const request = {
    project_id: "site-1",
    expected_workspace_digest: BASELINE,
    operations: operations(),
  };
  const first = await toolset.callTool("website_change_prepare", request);
  const second = await toolset.callTool("website_change_prepare", request);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.doesNotMatch(JSON.stringify(first), /<h1>B|old\.css|secret_internal/);

  const calls = backend.calls.filter(([name]) => name === "prepareChange");
  assert.equal(calls.length, 2);
  assert.match(calls[0][1].idempotency_key, /^website-change-prepare:[a-f0-9]{64}$/);
  assert.equal(calls[1][1].idempotency_key, calls[0][1].idempotency_key);

  await toolset.callTool("website_change_prepare", {
    ...request,
    operations: operations("<h1>C</h1>\n"),
  });
  const third = backend.calls.filter(([name]) => name === "prepareChange")[2][1];
  assert.notEqual(third.idempotency_key, calls[0][1].idempotency_key);
});

test("apply accepts only project plus opaque prepared ID and re-gates exact authoritative review identity", async () => {
  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_change_apply", {
    project_id: "site-1",
    prepared_change_id: PREPARED_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.change.prepared_change_id, PREPARED_ID);
  assert.equal(result.change.operation_id, OPERATION_ID);
  assert.equal(result.change.operation_revision, "2");
  assert.equal(result.project.workflow_state, "review_required");
  assert.equal(result.project.current_workspace_digest, TARGET);

  const call = backend.calls.find(([name]) => name === "applyPreparedChange");
  assert.deepEqual(call[1], {
    project_id: "site-1",
    prepared_change_id: PREPARED_ID,
  });

  for (const injected of [
    { operations: operations() },
    { content: "x" },
    { expected_workspace_digest: BASELINE },
    { idempotency_key: "model" },
  ]) {
    assert.deepEqual(
      await toolset.callTool("website_change_apply", {
        project_id: "site-1",
        prepared_change_id: PREPARED_ID,
        ...injected,
      }),
      { ok: false, error_code: "REQUEST_INVALID" },
    );
  }
});

test("apply rejects substituted backend metadata or review state", async () => {
  const cases = [
    { backendResult: prepared({ project_id: "site-foreign" }) },
    { backendResult: applied({ prepared_change_id: "change-short" }) },
    { backendResult: applied({ operation_revision: "0" }) },
    { backendResult: applied({ target_workspace_digest: BASELINE }) },
    { backendResult: applied({ workspace_digest: BASELINE }) },
  ];
  for (const item of cases) {
    const backend = makeBackend({
      prepareImpl: async () => prepared(),
      applyImpl: async () => item.backendResult,
    });
    const toolset = createStaticWebsiteToolset({ backend });
    const result = await toolset.callTool("website_change_apply", {
      project_id: "site-1",
      prepared_change_id: PREPARED_ID,
    });
    assert.equal(result.ok, false);
  }

  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
  });
  backend.setProject(project({
    workflow_state: "accepted",
    current_workspace_digest: TARGET,
    active_operation_id: OPERATION_ID,
    active_operation_revision: "2",
    operation_identity_status: "bound",
  }));
  backend.applyPreparedChange = async (request) => {
    backend.calls.push(["applyPreparedChange", structuredClone(request)]);
    return applied();
  };
  const toolset = createStaticWebsiteToolset({ backend });
  assert.deepEqual(
    await toolset.callTool("website_change_apply", {
      project_id: "site-1",
      prepared_change_id: PREPARED_ID,
    }),
    { ok: false, error_code: "CHANGE_REVIEW_STATE_INVALID" },
  );
});

test("accept/reject schema accepts only opaque approval reference, never raw evidence/caller/idempotency", async () => {
  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
    acceptImpl: async (request) => ({
      ok: true,
      transition: "accept",
      authorization_id: request.authorization_evidence.authorization_id,
      state: project({ workflow_state: "accepted", current_workspace_digest: TARGET }),
    }),
    rejectImpl: async (request) => ({
      ok: true,
      transition: "reject",
      authorization_id: request.authorization_evidence.authorization_id,
      state: project({
        workflow_state: "working",
        current_workspace_digest: BASELINE,
        active_operation_id: null,
        active_operation_revision: null,
        operation_identity_status: "none",
      }),
    }),
  });
  backend.setProject(project({
    workflow_state: "review_required",
    current_workspace_digest: TARGET,
    active_operation_id: OPERATION_ID,
    active_operation_revision: "2",
    operation_identity_status: "bound",
  }));
  const toolset = createStaticWebsiteToolset({ backend, approvals: approvalResolver() });
  const args = {
    project_id: "site-1",
    operation_id: OPERATION_ID,
    operation_revision: "2",
    expected_workspace_digest: TARGET,
    approval_id: APPROVAL_ID,
  };

  for (const name of ["website_change_accept", "website_change_reject"]) {
    const tool = toolset.tools.find((entry) => entry.name === name);
    assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const injected of [
      { authorization_evidence: {} },
      { caller_class: "trusted_control_plane" },
      { idempotency_key: "model-controlled" },
      { transition: "release_activate" },
    ]) {
      assert.deepEqual(
        await toolset.callTool(name, { ...args, ...injected }),
        { ok: false, error_code: "REQUEST_INVALID" },
      );
    }
  }
});

test("accept resolves exact opaque approval binding and never invokes release authority", async () => {
  const approvals = approvalResolver();
  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
    acceptImpl: async (request) => ({
      ok: true,
      transition: "accept",
      authorization_id: request.authorization_evidence.authorization_id,
      state: project({
        workflow_state: "accepted",
        current_workspace_digest: TARGET,
        accepted_workspace_digest: TARGET,
        accepted_snapshot_id: "snapshot-" + "n".repeat(32),
        active_operation_id: OPERATION_ID,
        active_operation_revision: "2",
        operation_identity_status: "bound",
      }),
    }),
    rejectImpl: async () => { throw new Error("not-used"); },
  });
  backend.setProject(project({
    workflow_state: "review_required",
    current_workspace_digest: TARGET,
    active_operation_id: OPERATION_ID,
    active_operation_revision: "2",
    operation_identity_status: "bound",
  }));
  const toolset = createStaticWebsiteToolset({ backend, approvals });
  const result = await toolset.callTool("website_change_accept", {
    project_id: "site-1",
    operation_id: OPERATION_ID,
    operation_revision: "2",
    expected_workspace_digest: TARGET,
    approval_id: APPROVAL_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.transition, "accept");
  assert.equal(result.project.workflow_state, "accepted");

  assert.equal(approvals.calls.length, 1);
  const resolved = approvals.calls[0];
  assert.equal(resolved.approval_id, APPROVAL_ID);
  assert.equal(resolved.tool_name, "website_change_accept");
  assert.equal(resolved.backend_transition, "accept");
  assert.equal(resolved.caller_class, "model_orchestrator");
  assert.match(resolved.idempotency_key, /^website-change-accept:[a-f0-9]{64}$/);

  const sent = backend.calls.find(([name]) => name === "acceptChange")[1];
  assert.equal(sent.caller_class, "model_orchestrator");
  assert.equal(sent.idempotency_key, resolved.idempotency_key);
  assert.equal(sent.authorization_evidence.operation_revision, "2");
  assert.equal(backend.calls.some(([name]) => /release/i.test(name)), false);
});

test("reject exact approval restores backend-projected baseline state and never calls release", async () => {
  const approvals = approvalResolver();
  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
    acceptImpl: async () => { throw new Error("not-used"); },
    rejectImpl: async (request) => ({
      ok: true,
      transition: "reject",
      authorization_id: request.authorization_evidence.authorization_id,
      state: project({
        workflow_state: "working",
        current_workspace_digest: BASELINE,
        active_operation_id: null,
        active_operation_revision: null,
        operation_identity_status: "none",
      }),
    }),
  });
  backend.setProject(project({
    workflow_state: "review_required",
    current_workspace_digest: TARGET,
    active_operation_id: OPERATION_ID,
    active_operation_revision: "2",
    operation_identity_status: "bound",
  }));
  const toolset = createStaticWebsiteToolset({ backend, approvals });
  const result = await toolset.callTool("website_change_reject", {
    project_id: "site-1",
    operation_id: OPERATION_ID,
    operation_revision: "2",
    expected_workspace_digest: TARGET,
    approval_id: APPROVAL_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.transition, "reject");
  assert.equal(result.project.workflow_state, "working");
  assert.equal(result.project.current_workspace_digest, BASELINE);
  assert.equal(result.project.active_operation_id, null);
  assert.equal(backend.calls.some(([name]) => /release/i.test(name)), false);
});

test("approval mismatch/denial/provider failure fails closed before backend human transition", async () => {
  for (const mismatch of [
    "decision",
    "transition",
    "project_id",
    "operation_id",
    "operation_revision",
    "digest",
    "idempotency",
    "caller",
  ]) {
    const backend = makeBackend({
      prepareImpl: async () => prepared(),
      applyImpl: async () => applied(),
      acceptImpl: async () => { throw new Error("must-not-run"); },
      rejectImpl: async () => { throw new Error("must-not-run"); },
    });
    backend.setProject(project({
      workflow_state: "review_required",
      current_workspace_digest: TARGET,
      active_operation_id: OPERATION_ID,
      active_operation_revision: "2",
      operation_identity_status: "bound",
    }));
    const toolset = createStaticWebsiteToolset({
      backend,
      approvals: approvalResolver({ mismatch }),
    });
    const result = await toolset.callTool("website_change_accept", {
      project_id: "site-1",
      operation_id: OPERATION_ID,
      operation_revision: "2",
      expected_workspace_digest: TARGET,
      approval_id: APPROVAL_ID,
    });
    assert.deepEqual(result, { ok: false, error_code: "APPROVAL_INVALID" });
    assert.equal(backend.calls.some(([name]) => name === "acceptChange"), false);
  }

  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
    acceptImpl: async () => { throw new Error("must-not-run"); },
    rejectImpl: async () => { throw new Error("must-not-run"); },
  });
  backend.setProject(project({
    workflow_state: "review_required",
    current_workspace_digest: TARGET,
    active_operation_id: OPERATION_ID,
    active_operation_revision: "2",
    operation_identity_status: "bound",
  }));
  const toolset = createStaticWebsiteToolset({
    backend,
    approvals: approvalResolver({ throwError: true }),
  });
  assert.deepEqual(
    await toolset.callTool("website_change_accept", {
      project_id: "site-1",
      operation_id: OPERATION_ID,
      operation_revision: "2",
      expected_workspace_digest: TARGET,
      approval_id: APPROVAL_ID,
    }),
    { ok: false, error_code: "APPROVAL_UNAVAILABLE" },
  );
});

test("stale review identity blocks approval resolution entirely", async () => {
  const approvals = approvalResolver();
  const backend = makeBackend({
    prepareImpl: async () => prepared(),
    applyImpl: async () => applied(),
    acceptImpl: async () => { throw new Error("must-not-run"); },
    rejectImpl: async () => { throw new Error("must-not-run"); },
  });
  backend.setProject(project({
    workflow_state: "review_required",
    current_workspace_digest: TARGET,
    active_operation_id: OPERATION_ID,
    active_operation_revision: "3",
    operation_identity_status: "bound",
  }));
  const toolset = createStaticWebsiteToolset({ backend, approvals });
  assert.deepEqual(
    await toolset.callTool("website_change_accept", {
      project_id: "site-1",
      operation_id: OPERATION_ID,
      operation_revision: "2",
      expected_workspace_digest: TARGET,
      approval_id: APPROVAL_ID,
    }),
    { ok: false, error_code: "ACTIVE_OPERATION_REVISION_MISMATCH" },
  );
  assert.equal(approvals.calls.length, 0);
});

test("in-process adapter exposes only fixed mutation methods when prepared-change authority is composed", async () => {
  const calls = [];
  const lifecycle = {
    getProject() {
      return project({
        workflow_state: "review_required",
        current_workspace_digest: TARGET,
        active_operation_id: OPERATION_ID,
        active_operation_revision: "2",
        operation_identity_status: "bound",
      });
    },
    async executeHumanTransition({ transition, request }) {
      calls.push(["executeHumanTransition", transition, structuredClone(request)]);
      return {
        ok: true,
        transition,
        authorization_id: request.authorization_evidence.authorization_id,
        state: this.getProject(),
      };
    },
  };
  const workspace = {
    listFiles() { return []; },
    computeDigest() { return TARGET; },
  };
  const changeAuthority = {
    prepareChange(request) {
      calls.push(["prepareChange", structuredClone(request)]);
      return prepared();
    },
    applyPreparedChange(request) {
      calls.push(["applyPreparedChange", structuredClone(request)]);
      return applied();
    },
    genericTransition() {
      throw new Error("must not expose");
    },
  };
  const adapter = createInProcessStaticBackendAdapter({
    lifecycle,
    workspace,
    validateWorkspace: async () => ({ ok: true }),
    startDevelopmentPreview: async () => { throw new Error("not-used"); },
    changeAuthority,
  });

  assert.deepEqual(Object.keys(adapter).sort(), [
    "acceptChange",
    "applyPreparedChange",
    "getProject",
    "listWorkspaceFiles",
    "prepareChange",
    "rejectChange",
    "startDevelopmentPreview",
    "validateWorkspace",
  ]);

  await adapter.acceptChange({
    project_id: "site-1",
    operation_id: OPERATION_ID,
    operation_revision: "2",
    expected_workspace_digest: TARGET,
    idempotency_key: "idem",
    caller_class: "model_orchestrator",
    authorization_evidence: { authorization_id: "a" },
  });
  assert.deepEqual(calls.at(-1).slice(0, 2), ["executeHumanTransition", "accept"]);
  assert.equal(Object.hasOwn(adapter, "executeHumanTransition"), false);
  assert.equal(Object.hasOwn(adapter, "genericTransition"), false);
});


test("exact accept and reject retries can reach backend idempotency after the state transition", async () => {
  for (const transition of ["accept", "reject"]) {
    const approvals = approvalResolver();
    const backend = makeBackend({
      prepareImpl: async () => prepared(),
      applyImpl: async () => applied(),
      acceptImpl: async (request) => ({
        ok: true,
        transition: "accept",
        authorization_id: request.authorization_evidence.authorization_id,
        state: project({
          workflow_state: "accepted",
          current_workspace_digest: TARGET,
          accepted_workspace_digest: TARGET,
          accepted_snapshot_id: "snapshot-" + "z".repeat(32),
          active_operation_id: OPERATION_ID,
          active_operation_revision: "2",
          operation_identity_status: "bound",
        }),
      }),
      rejectImpl: async (request) => ({
        ok: true,
        transition: "reject",
        authorization_id: request.authorization_evidence.authorization_id,
        state: project({
          workflow_state: "working",
          current_workspace_digest: BASELINE,
          accepted_workspace_digest: BASELINE,
          active_operation_id: null,
          active_operation_revision: null,
          operation_identity_status: "none",
        }),
      }),
    });
    backend.setProject(project({
      workflow_state: "review_required",
      current_workspace_digest: TARGET,
      accepted_workspace_digest: BASELINE,
      active_operation_id: OPERATION_ID,
      active_operation_revision: "2",
      operation_identity_status: "bound",
    }));
    const toolset = createStaticWebsiteToolset({ backend, approvals });
    const name = "website_change_" + transition;
    const args = {
      project_id: "site-1",
      operation_id: OPERATION_ID,
      operation_revision: "2",
      expected_workspace_digest: TARGET,
      approval_id: APPROVAL_ID,
    };
    const first = await toolset.callTool(name, args);
    assert.equal(first.ok, true);
    const second = await toolset.callTool(name, args);
    assert.deepEqual(second, first);
    assert.equal(
      backend.calls.filter(([call]) => call === (transition === "accept" ? "acceptChange" : "rejectChange")).length,
      2,
    );
    assert.equal(approvals.calls.length, 2);
  }
});
