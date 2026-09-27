import test from "node:test";
import assert from "node:assert/strict";
import {
  createInProcessStaticBackendAdapter,
  createStaticWebsiteToolset,
} from "../src/index.mjs";

const DIGEST = "c".repeat(64);

function fixture() {
  const calls = [];
  const lifecycle = {
    getProject(projectId) {
      calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "operation-real-shape",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
  };
  const workspace = {
    listFiles(projectId) {
      calls.push(["listFiles", projectId]);
      return [{ path: "index.html", size: 12 }];
    },    computeDigest(projectId) {
      calls.push(["computeDigest", projectId]);
      return DIGEST;
    },
  };
  const validateWorkspace = (request) => {
    calls.push(["validateWorkspace", request]);
    assert.equal(request.workspace, workspace);
    return {
      ok: true,
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      entrypoint: "index.html",
      findings: [],
    };
  };
  const startDevelopmentPreview = async (request) => {
    calls.push(["startDevelopmentPreview", request]);
    assert.equal(request.workspace, workspace);
    return {
      preview_id: "preview-real-shape",
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      host: "127.0.0.1",
      port: 41888,
      token: "d".repeat(64),
      url: "http://127.0.0.1:41888/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      close: async () => calls.push(["close"]),
    };
  };
  return {
    calls,
    lifecycle,
    workspace,
    validateWorkspace,
    startDevelopmentPreview,
  };
}

test("in-process adapter exposes only the fixed backend methods", () => {
  const fx = fixture();
  const adapter = createInProcessStaticBackendAdapter(fx);
  assert.deepEqual(Object.keys(adapter).sort(), [
    "getProject",
    "listWorkspaceFiles",
    "startDevelopmentPreview",
    "validateWorkspace",
  ]);
});test("toolset runs through the real backend object shape without arbitrary RPC", async () => {
  const fx = fixture();
  const adapter = createInProcessStaticBackendAdapter(fx);
  const toolset = createStaticWebsiteToolset({ backend: adapter });

  const status = await toolset.callTool("website_project_status", {
    project_id: "site-real-shape",
  });
  assert.equal(status.ok, true);

  const inspect = await toolset.callTool("website_project_inspect", {
    project_id: "site-real-shape",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(inspect.files, [{ path: "index.html", size: 12 }]);

  const validation = await toolset.callTool("website_build_check", {
    project_id: "site-real-shape",
    operation_id: "operation-real-shape",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.validation.valid, true);

  const preview = await toolset.callTool("website_preview_get", {
    project_id: "site-real-shape",
    operation_id: "operation-real-shape",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.project_id, "site-real-shape");
  assert.equal(preview.preview.workspace_digest, DIGEST);

  await toolset.close();
  assert.ok(fx.calls.some(([name]) => name === "close"));
});

test("adapter rejects incomplete backend dependencies at construction", () => {
  const fx = fixture();
  assert.throws(
    () => createInProcessStaticBackendAdapter({ ...fx, lifecycle: {} }),
    /lifecycle_getProject_required/,
  );
  assert.throws(
    () => createInProcessStaticBackendAdapter({ ...fx, workspace: {} }),
    /workspace_listFiles_required/,
  );
  assert.throws(
    () => createInProcessStaticBackendAdapter({ ...fx, validateWorkspace: null }),
    /validate_workspace_required/,
  );
});
test("in-process manifest capture is digest-bound before and after listing", () => {
  let digest = DIGEST;
  const fx = fixture();
  fx.workspace.computeDigest = () => digest;
  fx.workspace.listFiles = () => {
    digest = "f".repeat(64);
    return [{ path: "index.html", size: 12 }];
  };
  const adapter = createInProcessStaticBackendAdapter(fx);
  assert.throws(
    () => adapter.listWorkspaceFiles("site-real-shape", DIGEST),
    /workspace_digest_mismatch/,
  );
});

test("async validation stays digest-bound across the awaited validator", async () => {
  let digest = DIGEST;
  const fx = fixture();
  fx.workspace.computeDigest = () => digest;
  fx.validateWorkspace = async (request) => {
    await Promise.resolve();
    digest = "e".repeat(64);
    return {
      ok: true,
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      findings: [],
    };
  };
  const adapter = createInProcessStaticBackendAdapter(fx);
  await assert.rejects(
    () => adapter.validateWorkspace({
      project_id: "site-real-shape",
      operation_id: "operation-real-shape",
      operation_revision: "1",
      expected_workspace_digest: DIGEST,
    }),
    /workspace_digest_mismatch/,
  );
});

test("preview allocation is digest-bound before and after and closes stale preview", async () => {
  let digest = DIGEST;
  let closed = 0;
  const fx = fixture();
  fx.workspace.computeDigest = () => digest;
  fx.startDevelopmentPreview = async (request) => {
    digest = "f".repeat(64);
    return {
      preview_id: "preview-stale-adapter",
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      host: "127.0.0.1",
      port: 41889,
      token: "d".repeat(64),
      url: "http://127.0.0.1:41889/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      close: async () => { closed += 1; },
    };
  };
  const adapter = createInProcessStaticBackendAdapter(fx);
  await assert.rejects(
    () => adapter.startDevelopmentPreview({
      project_id: "site-real-shape",
      operation_id: "operation-real-shape",
      operation_revision: "1",
      expected_workspace_digest: DIGEST,
    }),
    /workspace_digest_mismatch/,
  );
  assert.equal(closed, 1);
});

test("adapter rejects operation revision change across awaited validation", async () => {
  let revision = "1";
  const fx = fixture();
  fx.lifecycle.getProject = (projectId) => ({
    project_id: projectId,
    project_type: "static_web",
    workflow_state: "review_required",
    current_workspace_digest: DIGEST,
    accepted_workspace_digest: null,
    accepted_snapshot_id: null,
    active_operation_id: "operation-real-shape",
    active_operation_revision: revision,
    operation_identity_status: "bound",
    ready_release_id: null,
    active_release_id: null,
    pending_external_transition: null,
  });
  fx.validateWorkspace = async (request) => {
    await Promise.resolve();
    revision = "2";
    return {
      ok: true,
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      findings: [],
    };
  };
  const adapter = createInProcessStaticBackendAdapter(fx);
  await assert.rejects(
    () => adapter.validateWorkspace({
      project_id: "site-real-shape",
      operation_id: "operation-real-shape",
      operation_revision: "1",
      expected_workspace_digest: DIGEST,
    }),
    /operation_revision_mismatch/,
  );
});

test("adapter closes preview when operation revision changes during allocation", async () => {
  let revision = "1";
  let closed = 0;
  const fx = fixture();
  fx.lifecycle.getProject = (projectId) => ({
    project_id: projectId,
    project_type: "static_web",
    workflow_state: "review_required",
    current_workspace_digest: DIGEST,
    accepted_workspace_digest: null,
    accepted_snapshot_id: null,
    active_operation_id: "operation-real-shape",
    active_operation_revision: revision,
    operation_identity_status: "bound",
    ready_release_id: null,
    active_release_id: null,
    pending_external_transition: null,
  });
  fx.startDevelopmentPreview = async (request) => {
    revision = "2";
    return {
      preview_id: "preview-operation-revision-race",
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      host: "127.0.0.1",
      port: 41890,
      token: "d".repeat(64),
      url: "http://127.0.0.1:41890/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      close: async () => { closed += 1; },
    };
  };
  const adapter = createInProcessStaticBackendAdapter(fx);
  await assert.rejects(
    () => adapter.startDevelopmentPreview({
      project_id: "site-real-shape",
      operation_id: "operation-real-shape",
      operation_revision: "1",
      expected_workspace_digest: DIGEST,
    }),
    /operation_revision_mismatch/,
  );
  assert.equal(closed, 1);
});

test("toolset retains adapter-allocated preview when stale-fence cleanup initially fails", async () => {
  let revision = "1";
  let closeAttempts = 0;
  const fx = fixture();
  fx.lifecycle.getProject = (projectId) => ({
    project_id: projectId,
    project_type: "static_web",
    workflow_state: "review_required",
    current_workspace_digest: DIGEST,
    accepted_workspace_digest: null,
    accepted_snapshot_id: null,
    active_operation_id: "operation-real-shape",
    active_operation_revision: revision,
    operation_identity_status: "bound",
    ready_release_id: null,
    active_release_id: null,
    pending_external_transition: null,
  });
  fx.startDevelopmentPreview = async (request) => {
    revision = "2";
    return {
      preview_id: "preview-hidden-cleanup-retry",
      project_id: request.project_id,
      workspace_digest: request.expected_workspace_digest,
      host: "127.0.0.1",
      port: 41891,
      token: "d".repeat(64),
      url: "http://127.0.0.1:41891/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      close: async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("transient adapter cleanup failure");
      },
    };
  };

  const adapter = createInProcessStaticBackendAdapter(fx);
  const toolset = createStaticWebsiteToolset({ backend: adapter });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-real-shape",
    operation_id: "operation-real-shape",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });

  assert.deepEqual(result, { ok: false, error_code: "PREVIEW_CLOSE_FAILED" });
  assert.equal(closeAttempts, 1);

  await toolset.close();
  assert.equal(closeAttempts, 2);
});
