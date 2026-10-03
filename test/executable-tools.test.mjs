import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTABLE_WEBSITE_TOOL_NAMES,
  WEBSITE_TOOLSET_STATUS,
  createStaticWebsiteToolset,
} from "../src/index.mjs";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

function makeBackend(overrides = {}) {
  const calls = [];
  const backend = {
    calls,
    getProject(projectId) {
      calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "operation-1",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
        secret_internal: "must-not-leak",
      };
    },    listWorkspaceFiles(projectId) {
      calls.push(["listWorkspaceFiles", projectId]);
      return [
        { path: "index.html", size: 120 },
        { path: "assets/app.css", size: 55 },
      ];
    },
    validateWorkspace(request) {
      calls.push(["validateWorkspace", structuredClone(request)]);
      return {
        ok: true,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        entrypoint: "index.html",
        findings: [],
        raw_log: "must-not-leak",
      };
    },
    async startDevelopmentPreview(request) {
      calls.push(["startDevelopmentPreview", structuredClone(request)]);
      return {
        preview_id: "preview-1234567890abcdef",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
        token: "d".repeat(64),
        close: async () => {},
      };
    },
    ...overrides,
  };
  return backend;
}

test("executable registry exposes only the safe read/review static_web subset", () => {
  assert.deepEqual(EXECUTABLE_WEBSITE_TOOL_NAMES, [    "website_project_status",
    "website_project_inspect",
    "website_build_check",
    "website_preview_get",
    "website_local_files_find",
    "website_asset_import",
  ]);
  assert.equal(WEBSITE_TOOLSET_STATUS.executable_tools, true);
  assert.deepEqual(WEBSITE_TOOLSET_STATUS.executable_tool_names, [
    "website_project_status",
    "website_project_inspect",
    "website_build_check",
    "website_preview_get",
  ]);
  assert.ok(EXECUTABLE_WEBSITE_TOOL_NAMES.includes("website_local_files_find"));
});

test("tool schemas are closed and model cannot inject authority fields", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  for (const tool of toolset.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const result = await toolset.callTool("website_project_status", {
    project_id: "site-1",
    caller_class: "human_review_surface",
  });
  assert.deepEqual(result, { ok: false, error_code: "REQUEST_INVALID" });
  assert.equal(backend.calls.length, 0);
});

test("status projects only bounded backend state", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_status", {
    project_id: "site-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.project.project_id, "site-1");
  assert.equal(result.project.current_workspace_digest, DIGEST);
  assert.equal("secret_internal" in result.project, false);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});test("inspect is digest-bound and never reads file contents", async () => {
  const backend = makeBackend({
    readWorkspaceFile() {
      throw new Error("inspect must not read bytes");
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_inspect", {
    project_id: "site-1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(result.ok, true);
  assert.equal(result.workspace_digest, DIGEST);
  assert.deepEqual(result.files, [
    { path: "assets/app.css", size: 55 },
    { path: "index.html", size: 120 },
  ]);
  assert.equal(backend.calls.some(([name]) => name === "readWorkspaceFile"), false);
});

test("inspect rejects stale digest before listing workspace", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_inspect", {
    project_id: "site-1",
    expected_workspace_digest: OTHER_DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "STALE_WORKSPACE" });
  assert.deepEqual(backend.calls.map(([name]) => name), ["getProject"]);
});

test("build check binds project operation and digest then sanitizes findings", async () => {
  const backend = makeBackend({
    validateWorkspace(request) {
      backend.calls.push(["validateWorkspace", structuredClone(request)]);
      return {
        ok: false,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        findings: [
          { code: "entrypoint_missing", path: "index.html", severity: "error", source: "<secret>" },
        ],
        stack: "secret-stack",
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_build_check", {    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, {
    ok: true,
    validation: {
      valid: false,
      project_id: "site-1",
      operation_id: "operation-1",
      operation_revision: "1",
      workspace_digest: DIGEST,
      findings: [{ code: "entrypoint_missing", path: "index.html", severity: "error" }],
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("build check rejects foreign operation before validation", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_build_check", {
    project_id: "site-1",
    operation_id: "operation-foreign",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "ACTIVE_CHANGE_MISMATCH" });
  assert.deepEqual(backend.calls.map(([name]) => name), ["getProject"]);
});

test("preview is exact-identity bound and returns only loopback projection", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.preview, {
    preview_id: "preview-1234567890abcdef",
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    workspace_digest: DIGEST,
    url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
  });
  assert.equal("token" in result.preview, false);
});test("preview rejects non-loopback or substituted backend identity", async () => {
  for (const preview of [
    {
      preview_id: "preview-1",
      project_id: "site-1",
      workspace_digest: DIGEST,
      url: "https://example.com/preview/token/index.html",
      close: async () => {},
    },
    {
      preview_id: "preview-2",
      project_id: "site-2",
      workspace_digest: DIGEST,
      url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      close: async () => {},
    },
    {
      preview_id: "preview-3",
      project_id: "site-1",
      workspace_digest: OTHER_DIGEST,
      url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      close: async () => {},
    },
  ]) {
    const backend = makeBackend({
      async startDevelopmentPreview() {
        backend.calls.push(["startDevelopmentPreview"]);
        return preview;
      },
    });
    const toolset = createStaticWebsiteToolset({ backend });
    const result = await toolset.callTool("website_preview_get", {
      project_id: "site-1",
      operation_id: "operation-1",
      operation_revision: "1",
      expected_workspace_digest: DIGEST,
    });
    assert.deepEqual(result, { ok: false, error_code: "BACKEND_IDENTITY_MISMATCH" });
  }
});

test("disabled and unknown tools never reach backend", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  assert.deepEqual(
    await toolset.callTool("website_change_accept", {}),
    { ok: false, error_code: "CAPABILITY_UNAVAILABLE" },
  );
  assert.deepEqual(
    await toolset.callTool("website_arbitrary_rpc", {}),
    { ok: false, error_code: "TOOL_NOT_FOUND" },
  );
  assert.equal(backend.calls.length, 0);
});test("backend exceptions are sanitized", async () => {
  const backend = makeBackend({
    getProject() {
      throw new Error("secret-provider-token=abc123");
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_status", {
    project_id: "site-1",
  });
  assert.deepEqual(result, { ok: false, error_code: "BACKEND_FAILURE" });
  assert.doesNotMatch(JSON.stringify(result), /secret|abc123/);
});

test("preview refuses stale digest and unsupported workflow before starting", async () => {
  for (const override of [
    { current_workspace_digest: OTHER_DIGEST },
    { workflow_state: "working" },
  ]) {
    const backend = makeBackend({
      getProject(projectId) {
        backend.calls.push(["getProject", projectId]);
        return {
          project_id: projectId,
          project_type: "static_web",
          workflow_state: "review_required",
          current_workspace_digest: DIGEST,
          active_operation_id: "operation-1",
          active_operation_revision: "1",
          operation_identity_status: "bound",
          ...override,
        };
      },
    });
    const toolset = createStaticWebsiteToolset({ backend });
    const result = await toolset.callTool("website_preview_get", {
      project_id: "site-1",
      operation_id: "operation-1",
      operation_revision: "1",
      expected_workspace_digest: DIGEST,
    });
    assert.equal(result.ok, false);
    assert.equal(
      backend.calls.some(([name]) => name === "startDevelopmentPreview"),
      false,
    );
  }
});
test("status rejects malformed optional backend identifiers without leaking them", async () => {
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: "secret\nbackend-payload",
        active_operation_id: "operation-1",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_status", {
    project_id: "site-1",
  });
  assert.deepEqual(result, { ok: false, error_code: "BACKEND_RESPONSE_INVALID" });
  assert.doesNotMatch(JSON.stringify(result), /secret|backend-payload/);
});

test("preview rejects loopback URLs with query data", async () => {
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      backend.calls.push(["startDevelopmentPreview", structuredClone(request)]);
      return {
        preview_id: "preview-query",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        url: "http://127.0.0.1:43123/preview/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/index.html?secret=1",
        close: async () => {},
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "BACKEND_IDENTITY_MISMATCH" });
});

test("reserved Windows project identifiers are rejected before backend calls", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  assert.deepEqual(
    await toolset.callTool("website_project_status", { project_id: "CON" }),
    { ok: false, error_code: "REQUEST_INVALID" },
  );
  assert.equal(backend.calls.length, 0);
});

test("preview URL token must match the backend preview token", async () => {
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      backend.calls.push(["startDevelopmentPreview", structuredClone(request)]);
      return {
        preview_id: "preview-token-mismatch",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        token: "f".repeat(64),
        url: "http://127.0.0.1:43123/preview/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/index.html",
        close: async () => {},
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "BACKEND_IDENTITY_MISMATCH" });
});

test("inspect detects a workspace state change across manifest capture", async () => {
  let currentDigest = DIGEST;
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: currentDigest,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "operation-1",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    listWorkspaceFiles(projectId) {
      backend.calls.push(["listWorkspaceFiles", projectId]);
      currentDigest = OTHER_DIGEST;
      return [{ path: "index.html", size: 120 }];
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_inspect", {
    project_id: "site-1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "STALE_WORKSPACE" });
  assert.equal(
    backend.calls.filter(([name]) => name === "getProject").length,
    2,
  );
});

test("concurrent preview calls single-flight one backend preview allocation", async () => {
  let starts = 0;
  let resolveStart;
  const started = new Promise((resolve) => { resolveStart = resolve; });
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      starts += 1;
      await started;
      return {
        preview_id: "preview-singleflight",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        token: "d".repeat(64),
        url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
        close: async () => {},
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const args = {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  };
  const first = toolset.callTool("website_preview_get", args);
  const second = toolset.callTool("website_preview_get", args);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  resolveStart();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
});

test("preview cache automatically closes entries on bounded TTL", async () => {
  const scheduled = [];
  let closed = 0;
  const scheduler = {
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout() {},
  };
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      return {
        preview_id: "preview-expiring",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        token: "d".repeat(64),
        url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
        close: async () => { closed += 1; },
      };
    },
  });
  const toolset = createStaticWebsiteToolset({
    backend,
    previewTtlMs: 1_000,
    scheduler,
  });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(result.ok, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 1_000);
  await scheduled[0].fn();
  assert.equal(closed, 1);
});

test("build check re-gates lifecycle after awaited validation", async () => {
  let operation = "operation-1";
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: operation,
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async validateWorkspace(request) {
      backend.calls.push(["validateWorkspace", structuredClone(request)]);
      operation = "operation-replaced";
      return {
        ok: true,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        findings: [],
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_build_check", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "ACTIVE_CHANGE_MISMATCH" });
  assert.equal(backend.calls.filter(([name]) => name === "getProject").length, 2);
});

test("preview re-gates lifecycle after awaited allocation and closes stale result", async () => {
  let operation = "operation-1";
  let closed = 0;
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: operation,
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async startDevelopmentPreview(request) {
      backend.calls.push(["startDevelopmentPreview", structuredClone(request)]);
      operation = "operation-replaced";
      return {
        preview_id: "preview-race",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        token: "d".repeat(64),
        url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
        close: async () => { closed += 1; },
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, { ok: false, error_code: "ACTIVE_CHANGE_MISMATCH" });
  assert.equal(closed, 1);
  assert.equal(backend.calls.filter(([name]) => name === "getProject").length, 2);
});

test("distinct preview requests are serialized before allocation and respect cache bound", async () => {
  let activeStarts = 0;
  let maxActiveStarts = 0;
  let starts = 0;
  const resolvers = [];
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: projectId === "site-1" ? "operation-1" : "operation-2",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async startDevelopmentPreview(request) {
      starts += 1;
      activeStarts += 1;
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
      await new Promise((resolve) => resolvers.push(resolve));
      activeStarts -= 1;
      const token = starts === 1 ? "d".repeat(64) : "e".repeat(64);
      return {
        preview_id: "preview-" + starts,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43120 + starts,
        token,
        url: `http://127.0.0.1:${43120 + starts}/preview/${token}/index.html`,
        close: async () => {},
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend, maxCachedPreviews: 1 });
  const first = toolset.callTool("website_preview_get", {
    project_id: "site-1", operation_id: "operation-1", operation_revision: "1", expected_workspace_digest: DIGEST,
  });
  const second = toolset.callTool("website_preview_get", {
    project_id: "site-2", operation_id: "operation-2", operation_revision: "1", expected_workspace_digest: DIGEST,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  resolvers.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  resolvers.shift()();
  await second;
  assert.equal(maxActiveStarts, 1);
  await toolset.close();
});

test("close prevents queued preview allocation after shutdown begins", async () => {
  let starts = 0;
  let releaseFirst;
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      starts += 1;
      if (starts === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return {
        preview_id: "preview-close-" + starts,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43200 + starts,
        token: "d".repeat(64),
        url: `http://127.0.0.1:${43200 + starts}/preview/${"d".repeat(64)}/index.html`,
        close: async () => {},
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const first = toolset.callTool("website_preview_get", {
    project_id: "site-1", operation_id: "operation-1", operation_revision: "1", expected_workspace_digest: DIGEST,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closePromise = toolset.close();
  const queued = toolset.callTool("website_preview_get", {
    project_id: "site-1", operation_id: "operation-1", operation_revision: "1", expected_workspace_digest: DIGEST,
  });
  releaseFirst();
  await first;
  await closePromise;
  assert.deepEqual(await queued, { ok: false, error_code: "TOOLSET_CLOSED" });
  assert.equal(starts, 1);
});

test("project status exposes only validated operation incarnation metadata", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_project_status", {
    project_id: "site-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.project.active_operation_revision, "1");
  assert.equal(result.project.operation_identity_status, "bound");
});

test("build and preview require canonical operation revision strings", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  for (const name of ["website_build_check", "website_preview_get"]) {
    assert.deepEqual(
      await toolset.callTool(name, {
        project_id: "site-1",
        operation_id: "operation-1",
        expected_workspace_digest: DIGEST,
      }),
      { ok: false, error_code: "REQUEST_INVALID" },
    );
    assert.deepEqual(
      await toolset.callTool(name, {
        project_id: "site-1",
        operation_id: "operation-1",
        operation_revision: 1,
        expected_workspace_digest: DIGEST,
      }),
      { ok: false, error_code: "REQUEST_INVALID" },
    );
  }
  assert.equal(backend.calls.length, 0);
});

test("build rejects an old operation revision even when id and digest are identical", async () => {
  const backend = makeBackend();
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_build_check", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "2",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, {
    ok: false,
    error_code: "ACTIVE_OPERATION_REVISION_MISMATCH",
  });
  assert.deepEqual(backend.calls.map(([name]) => name), ["getProject"]);
});

test("build re-gate rejects operation ABA by immutable revision after awaited validation", async () => {
  let revision = "1";
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "operation-1",
        active_operation_revision: revision,
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async validateWorkspace(request) {
      backend.calls.push(["validateWorkspace", structuredClone(request)]);
      revision = "2";
      return {
        ok: true,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        findings: [],
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_build_check", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, {
    ok: false,
    error_code: "ACTIVE_OPERATION_REVISION_MISMATCH",
  });
});

test("preview re-gate closes result when operation revision changes during allocation", async () => {
  let revision = "1";
  let closed = 0;
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "operation-1",
        active_operation_revision: revision,
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async startDevelopmentPreview(request) {
      backend.calls.push(["startDevelopmentPreview", structuredClone(request)]);
      revision = "2";
      return {
        preview_id: "preview-revision-race",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        token: "d".repeat(64),
        url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
        close: async () => { closed += 1; },
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, {
    ok: false,
    error_code: "ACTIVE_OPERATION_REVISION_MISMATCH",
  });
  assert.equal(closed, 1);
});

test("preview cache identity includes operation revision", async () => {
  let revision = "1";
  let starts = 0;
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "operation-1",
        active_operation_revision: revision,
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async startDevelopmentPreview(request) {
      starts += 1;
      const token = starts === 1 ? "d".repeat(64) : "e".repeat(64);
      return {
        preview_id: "preview-revision-" + starts,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43120 + starts,
        token,
        url: `http://127.0.0.1:${43120 + starts}/preview/${token}/index.html`,
        close: async () => {},
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const first = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(first.ok, true);
  revision = "2";
  const second = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "2",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(second.ok, true);
  assert.equal(starts, 2);
  assert.notEqual(first.preview.preview_id, second.preview.preview_id);
});

test("successful preview requires a backend teardown handle", async () => {
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      return {
        preview_id: "preview-no-close",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43123,
        token: "d".repeat(64),
        url: "http://127.0.0.1:43123/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const result = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(result, {
    ok: false,
    error_code: "PREVIEW_CLOSE_FAILED",
  });
});

test("failed preview cleanup remains resource-bound and blocks capacity bypass", async () => {
  let starts = 0;
  let closeAttempts = 0;
  const backend = makeBackend({
    getProject(projectId) {
      backend.calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: DIGEST,
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: projectId === "site-1" ? "operation-1" : "operation-2",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    async startDevelopmentPreview(request) {
      starts += 1;
      const token = "d".repeat(64);
      return {
        preview_id: "preview-cleanup-failure-" + starts,
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43300 + starts,
        token,
        url: `http://127.0.0.1:${43300 + starts}/preview/${token}/index.html`,
        close: async () => {
          closeAttempts += 1;
          throw new Error("close failed");
        },
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend, maxCachedPreviews: 1 });
  const first = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(first.ok, true);

  const second = await toolset.callTool("website_preview_get", {
    project_id: "site-2",
    operation_id: "operation-2",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.deepEqual(second, { ok: false, error_code: "PREVIEW_CLOSE_FAILED" });
  assert.equal(starts, 1);
  assert.equal(closeAttempts, 1);
});

test("toolset close reports cleanup failure and retries tracked preview", async () => {
  let closeAttempts = 0;
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      const token = "d".repeat(64);
      return {
        preview_id: "preview-retry-close",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43321,
        token,
        url: `http://127.0.0.1:43321/preview/${token}/index.html`,
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("transient close failure");
        },
      };
    },
  });
  const toolset = createStaticWebsiteToolset({ backend });
  const preview = await toolset.callTool("website_preview_get", {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  });
  assert.equal(preview.ok, true);

  await assert.rejects(() => toolset.close(), /preview_close_failed/);
  assert.equal(closeAttempts, 1);
  assert.deepEqual(
    await toolset.callTool("website_project_status", { project_id: "site-1" }),
    { ok: false, error_code: "TOOLSET_CLOSED" },
  );

  await toolset.close();
  assert.equal(closeAttempts, 2);
});

test("expired preview with failed TTL cleanup is never reissued from cache", async () => {
  const scheduled = [];
  let starts = 0;
  let closeAttempts = 0;
  const scheduler = {
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout() {},
  };
  const backend = makeBackend({
    async startDevelopmentPreview(request) {
      starts += 1;
      return {
        preview_id: "preview-expired-cleanup-failure",
        project_id: request.project_id,
        workspace_digest: request.expected_workspace_digest,
        host: "127.0.0.1",
        port: 43125,
        token: "d".repeat(64),
        url: "http://127.0.0.1:43125/preview/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/index.html",
        close: async () => {
          closeAttempts += 1;
          throw new Error("transient close failure");
        },
      };
    },
  });
  const toolset = createStaticWebsiteToolset({
    backend,
    previewTtlMs: 1_000,
    scheduler,
  });
  const args = {
    project_id: "site-1",
    operation_id: "operation-1",
    operation_revision: "1",
    expected_workspace_digest: DIGEST,
  };

  const first = await toolset.callTool("website_preview_get", args);
  assert.equal(first.ok, true);
  assert.equal(starts, 1);

  await scheduled[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeAttempts, 1);

  const second = await toolset.callTool("website_preview_get", args);
  assert.deepEqual(second, { ok: false, error_code: "PREVIEW_CLOSE_FAILED" });
  assert.equal(starts, 1);
  assert.equal(closeAttempts, 2);
});
