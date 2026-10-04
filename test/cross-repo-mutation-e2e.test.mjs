import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createInProcessStaticBackendAdapter, createStaticWebsiteToolset } from "../src/index.mjs";

const backendRoot = process.env.RDC_WEB_BUILD_BACKEND_ROOT || "";
const backendIndex = path.join(backendRoot, "src", "index.mjs");
const available = backendRoot !== "" && fs.existsSync(backendIndex);

test("real backend mutation prepare apply accept reject stays separate from release", { skip: !available }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-mut-e2e-"));
  try {
    const api = await import(pathToFileURL(backendIndex).href);
    const workspace = new api.StaticWorkspaceAuthority(path.join(root, "workspace"));
    const store = new api.JsonLifecycleStore(path.join(root, "lifecycle.json"));
    const releaseCalls = [];
    const releaseAuthority = {
      prepareRelease(request) { releaseCalls.push(["prepare", request]); throw new Error("release forbidden"); },
      getPreparedRelease() { return null; },
      activateRelease(request) { releaseCalls.push(["activate", request]); throw new Error("release forbidden"); },
      getActivation() { return null; },
    };
    const issued = new Map();
    const lifecycle = new api.StaticLifecycleService({
      store,
      workspaceAuthority: workspace,
      releaseAuthority,
      verifyAuthorizationEvidence: async (evidence, binding) => {
        const expected = issued.get(evidence.authorization_id);
        return expected !== undefined
          && JSON.stringify(expected) === JSON.stringify(evidence)
          && evidence.transition === binding.transition
          && evidence.project_id === binding.project_id
          && evidence.operation_id === binding.operation_id
          && evidence.operation_revision === binding.operation_revision
          && evidence.expected_workspace_digest === binding.expected_workspace_digest
          && evidence.idempotency_key === binding.idempotency_key
          && evidence.caller_class === binding.caller_class;
      },
      now: () => Date.parse("2026-10-03T22:00:00.000Z"),
    });

    workspace.initializeProject("site-1", {
      "index.html": "<h1>A</h1>\n",
      "style.css": "body{margin:1rem}\n",
    });
    const initialDigest = workspace.computeDigest("site-1");
    assert.equal(lifecycle.createProject({
      project_id: "site-1",
      initial_workspace_digest: initialDigest,
    }).ok, true);

    let sequence = 0;
    const changes = api.createPreparedChangeAuthority({
      store,
      lifecycle,
      workspace,
      idFactory(kind) {
        sequence += 1;
        const suffix = String(sequence).padStart(32, "0");
        return (kind === "prepared_change" ? "change-" : "operation-") + suffix;
      },
      now: () => Date.parse("2026-10-03T22:00:00.000Z"),
    });

    const approvalsByRef = new Map();
    const approvals = {
      async resolveApproval(request) {
        const record = approvalsByRef.get(request.approval_id);
        if (!record) return null;
        for (const field of ["tool_name", "project_id", "operation_id", "operation_revision", "expected_workspace_digest"]) {
          if (record[field] !== request[field]) return null;
        }
        const evidence = Object.freeze({
          authorization_id: record.authorization_id,
          decision: "approved",
          transition: request.backend_transition,
          project_id: request.project_id,
          operation_id: request.operation_id,
          operation_revision: request.operation_revision,
          expected_workspace_digest: request.expected_workspace_digest,
          idempotency_key: request.idempotency_key,
          caller_class: request.caller_class,
          issued_at: "2026-10-03T21:59:00.000Z",
          expires_at: "2026-10-03T22:05:00.000Z",
        });
        issued.set(evidence.authorization_id, evidence);
        return evidence;
      },
    };

    const backend = createInProcessStaticBackendAdapter({
      lifecycle,
      workspace,
      validateWorkspace: async ({ project_id, expected_workspace_digest }) => ({
        ok: true,
        project_id,
        workspace_digest: expected_workspace_digest,
        findings: [],
      }),
      startDevelopmentPreview: async () => { throw new Error("preview unused"); },
      changeAuthority: changes,
    });
    const toolset = createStaticWebsiteToolset({ backend, approvals });

    const prepared1 = await toolset.callTool("website_change_prepare", {
      project_id: "site-1",
      expected_workspace_digest: initialDigest,
      operations: [
        { type: "write", path: "index.html", content: "<h1>B</h1>\n" },
        { type: "delete", path: "style.css" },
      ],
    });
    assert.equal(prepared1.ok, true);
    assert.equal(workspace.computeDigest("site-1"), initialDigest);

    const applied1 = await toolset.callTool("website_change_apply", {
      project_id: "site-1",
      prepared_change_id: prepared1.change.prepared_change_id,
    });
    assert.equal(applied1.ok, true);
    assert.equal(applied1.project.workflow_state, "review_required");
    assert.equal(workspace.readFile("site-1", "index.html").toString("utf8"), "<h1>B</h1>\n");

    const acceptRef = "approvalref-" + "a".repeat(32);
    approvalsByRef.set(acceptRef, {
      authorization_id: "authorization-" + "a".repeat(32),
      tool_name: "website_change_accept",
      project_id: "site-1",
      operation_id: applied1.change.operation_id,
      operation_revision: applied1.change.operation_revision,
      expected_workspace_digest: applied1.change.workspace_digest,
    });
    const accepted = await toolset.callTool("website_change_accept", {
      project_id: "site-1",
      operation_id: applied1.change.operation_id,
      operation_revision: applied1.change.operation_revision,
      expected_workspace_digest: applied1.change.workspace_digest,
      approval_id: acceptRef,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.project.workflow_state, "accepted");
    const acceptedRetry = await toolset.callTool("website_change_accept", {
      project_id: "site-1",
      operation_id: applied1.change.operation_id,
      operation_revision: applied1.change.operation_revision,
      expected_workspace_digest: applied1.change.workspace_digest,
      approval_id: acceptRef,
    });
    assert.deepEqual(acceptedRetry, accepted);
    const acceptedDigest = accepted.project.current_workspace_digest;

    const prepared2 = await toolset.callTool("website_change_prepare", {
      project_id: "site-1",
      expected_workspace_digest: acceptedDigest,
      operations: [{ type: "write", path: "index.html", content: "<h1>C</h1>\n" }],
    });
    const applied2 = await toolset.callTool("website_change_apply", {
      project_id: "site-1",
      prepared_change_id: prepared2.change.prepared_change_id,
    });
    assert.equal(applied2.ok, true);
    assert.equal(applied2.change.operation_revision, "2");
    assert.equal(workspace.readFile("site-1", "index.html").toString("utf8"), "<h1>C</h1>\n");

    const rejectRef = "approvalref-" + "r".repeat(32);
    approvalsByRef.set(rejectRef, {
      authorization_id: "authorization-" + "r".repeat(32),
      tool_name: "website_change_reject",
      project_id: "site-1",
      operation_id: applied2.change.operation_id,
      operation_revision: applied2.change.operation_revision,
      expected_workspace_digest: applied2.change.workspace_digest,
    });
    const rejected = await toolset.callTool("website_change_reject", {
      project_id: "site-1",
      operation_id: applied2.change.operation_id,
      operation_revision: applied2.change.operation_revision,
      expected_workspace_digest: applied2.change.workspace_digest,
      approval_id: rejectRef,
    });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.project.workflow_state, "working");
    assert.equal(rejected.project.current_workspace_digest, acceptedDigest);
    assert.equal(rejected.project.active_operation_id, null);
    assert.equal(workspace.readFile("site-1", "index.html").toString("utf8"), "<h1>B</h1>\n");
    const rejectedRetry = await toolset.callTool("website_change_reject", {
      project_id: "site-1",
      operation_id: applied2.change.operation_id,
      operation_revision: applied2.change.operation_revision,
      expected_workspace_digest: applied2.change.workspace_digest,
      approval_id: rejectRef,
    });
    assert.deepEqual(rejectedRetry, rejected);
    assert.equal(workspace.readFile("site-1", "index.html").toString("utf8"), "<h1>B</h1>\n");
    assert.deepEqual(releaseCalls, []);
    assert.equal(toolset.tools.some((entry) => entry.name === "website_release_activate"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
