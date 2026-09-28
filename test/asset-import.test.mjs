import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTABLE_WEBSITE_TOOL_NAMES,
  createInProcessStaticBackendAdapter,
  createStaticWebsiteToolset,
} from "../src/index.mjs";

const LOCAL_FILE_ID = "localfile-" + "x".repeat(32);
const ASSET_ID = "asset-" + "a".repeat(32);
const SOURCE_HANDLE_DIGEST = "sha256:"
  + crypto.createHash("sha256")
    .update("local_file_id:" + LOCAL_FILE_ID, "utf8")
    .digest("hex");
const CONTENT_DIGEST = "sha256:" + "c".repeat(64);
const MODIFIED_AT = "2026-09-28T09:00:00.000Z";
const CREATED_AT = "2026-09-28T09:01:00.000Z";

function project(projectId) {
  return {
    project_id: projectId,
    project_type: "static_web",
    workflow_state: "review_required",
    current_workspace_digest: "d".repeat(64),
    accepted_workspace_digest: null,
    accepted_snapshot_id: null,
    active_operation_id: "operation-1",
    active_operation_revision: "1",
    operation_identity_status: "bound",
    ready_release_id: null,
    active_release_id: null,
    pending_external_transition: null,
  };
}

function makeBackend({ importImpl } = {}) {
  const calls = [];
  const backend = {
    calls,
    getProject(projectId) {
      calls.push(["getProject", projectId]);
      return project(projectId);
    },
    listWorkspaceFiles() {
      throw new Error("not used");
    },
    validateWorkspace() {
      throw new Error("not used");
    },
    startDevelopmentPreview() {
      throw new Error("not used");
    },
  };
  if (importImpl) {
    backend.importLocalAsset = async (request) => {
      calls.push(["importLocalAsset", structuredClone(request)]);
      return importImpl(request);
    };
  }
  return backend;
}

function localFiles() {
  return {
    async findLocalFiles() {
      return { root_id: "photos", files: [] };
    },
  };
}

function args(overrides = {}) {
  return {
    project_id: "site-1",
    local_file_id: LOCAL_FILE_ID,
    size_bytes: 1234,
    modified_at: MODIFIED_AT,
    ...overrides,
  };
}

function validBackendResult(overrides = {}) {
  return {
    ok: true,
    asset: {
      asset_id: ASSET_ID,
      project_id: "site-1",
      source_class: "local_file",
      source_handle_digest: SOURCE_HANDLE_DIGEST,
      content_digest: CONTENT_DIGEST,
      size_bytes: 1234,
      mime_type: "image/png",
      relative_name: "hero.png",
      created_at: CREATED_AT,
      ...overrides,
    },
  };
}

test("asset import is visible only with local discovery and backend Media Library composition", async () => {
  assert.ok(EXECUTABLE_WEBSITE_TOOL_NAMES.includes("website_asset_import"));

  const noImport = createStaticWebsiteToolset({
    backend: makeBackend(),
    localFiles: localFiles(),
  });
  assert.equal(noImport.tools.some((tool) => tool.name === "website_asset_import"), false);
  assert.deepEqual(
    await noImport.callTool("website_asset_import", args()),
    { ok: false, error_code: "CAPABILITY_UNAVAILABLE" },
  );

  const noLocal = createStaticWebsiteToolset({
    backend: makeBackend({ importImpl: async () => validBackendResult() }),
  });
  assert.equal(noLocal.tools.some((tool) => tool.name === "website_asset_import"), false);
  assert.deepEqual(
    await noLocal.callTool("website_asset_import", args()),
    { ok: false, error_code: "CAPABILITY_UNAVAILABLE" },
  );

  const composed = createStaticWebsiteToolset({
    backend: makeBackend({ importImpl: async () => validBackendResult() }),
    localFiles: localFiles(),
  });
  assert.equal(composed.tools.some((tool) => tool.name === "website_asset_import"), true);
  assert.equal(composed.status.asset_import_composed, true);
  assert.ok(composed.status.executable_tool_names.includes("website_asset_import"));
});

test("asset import schema is closed and model cannot inject paths bytes authority or idempotency", async () => {
  const backend = makeBackend({ importImpl: async () => validBackendResult() });
  const toolset = createStaticWebsiteToolset({ backend, localFiles: localFiles() });
  const tool = toolset.tools.find((entry) => entry.name === "website_asset_import");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, [
    "project_id",
    "local_file_id",
    "size_bytes",
    "modified_at",
  ]);

  const invalid = [
    { ...args(), absolute_path: "D:\\Private\\hero.png" },
    { ...args(), bytes: "base64-secret" },
    { ...args(), caller_class: "trusted_control_plane" },
    { ...args(), idempotency_key: "model-controlled" },
    { ...args(), local_file_id: "bad" },
    { ...args(), project_id: "../site" },
    { ...args(), size_bytes: -1 },
    { ...args(), size_bytes: 1.5 },
    { ...args(), modified_at: "2026-09-28" },
  ];
  for (const request of invalid) {
    assert.deepEqual(
      await toolset.callTool("website_asset_import", request),
      { ok: false, error_code: "REQUEST_INVALID" },
    );
  }
  assert.equal(backend.calls.length, 0);
});

test("asset import delegates exact opaque identity and freshness with stable internal idempotency", async () => {
  const backend = makeBackend({
    importImpl: async () => validBackendResult(),
  });
  const toolset = createStaticWebsiteToolset({ backend, localFiles: localFiles() });

  const first = await toolset.callTool("website_asset_import", args());
  const second = await toolset.callTool("website_asset_import", args());
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);

  const importCalls = backend.calls.filter(([name]) => name === "importLocalAsset");
  assert.equal(importCalls.length, 2);
  const firstRequest = importCalls[0][1];
  const secondRequest = importCalls[1][1];
  assert.deepEqual(Object.keys(firstRequest).sort(), [
    "expected_content_digest",
    "expected_source",
    "idempotency_key",
    "local_file_id",
    "project_id",
  ]);
  assert.deepEqual(firstRequest, {
    project_id: "site-1",
    local_file_id: LOCAL_FILE_ID,
    expected_source: {
      size_bytes: 1234,
      modified_at: MODIFIED_AT,
    },
    expected_content_digest: null,
    idempotency_key: firstRequest.idempotency_key,
  });
  assert.match(firstRequest.idempotency_key, /^website-asset-import:[a-f0-9]{64}$/);
  assert.equal(secondRequest.idempotency_key, firstRequest.idempotency_key);
  assert.equal(backend.calls.some(([name]) => name === "getProject"), false);

  await toolset.callTool("website_asset_import", args({
    modified_at: "2026-09-28T09:02:00.000Z",
  }));
  const thirdRequest = backend.calls.filter(([name]) => name === "importLocalAsset")[2][1];
  assert.notEqual(thirdRequest.idempotency_key, firstRequest.idempotency_key);
});

test("asset import returns an exact bounded managed-asset projection", async () => {
  const backend = makeBackend({
    importImpl: async () => {
      const result = validBackendResult();
      result.asset.absolute_source_path = "D:\\Private\\hero.png";
      result.asset.contents = "secret-bytes";
      result.asset.provider_secret = "token-abc";
      return result;
    },
  });
  const toolset = createStaticWebsiteToolset({ backend, localFiles: localFiles() });
  const result = await toolset.callTool("website_asset_import", args());
  assert.deepEqual(result, {
    ok: true,
    asset: {
      asset_id: ASSET_ID,
      project_id: "site-1",
      source_class: "local_file",
      source_handle_digest: SOURCE_HANDLE_DIGEST,
      content_digest: CONTENT_DIGEST,
      size_bytes: 1234,
      mime_type: "image/png",
      relative_name: "hero.png",
      created_at: CREATED_AT,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /Private|secret|token-abc|contents/i);
});

test("asset import rejects substituted or malformed backend projections", async () => {
  const badAssets = [
    { project_id: "other-site" },
    { asset_id: "bad" },
    { source_class: "remote_url" },
    { source_handle_digest: "sha256:bad" },
    { source_handle_digest: "sha256:" + "f".repeat(64) },
    { content_digest: "sha256:bad" },
    { size_bytes: -1 },
    { size_bytes: 1235 },
    { mime_type: "text/html" },
    { relative_name: "../hero.png" },
    { created_at: "today" },
  ];
  for (const override of badAssets) {
    const backend = makeBackend({
      importImpl: async () => validBackendResult(override),
    });
    const toolset = createStaticWebsiteToolset({ backend, localFiles: localFiles() });
    const result = await toolset.callTool("website_asset_import", args());
    assert.deepEqual(result, { ok: false, error_code: "ASSET_RESPONSE_INVALID" });
    assert.doesNotMatch(JSON.stringify(result), /Private|secret|token/i);
  }
});

test("asset import maps expected backend denials and sanitizes arbitrary failures", async () => {
  const cases = [
    ["asset_project_unavailable", "ASSET_PROJECT_UNAVAILABLE"],
    ["asset_source_stale", "LOCAL_FILE_STALE"],
    ["asset_source_changed", "LOCAL_FILE_CHANGED"],
    ["asset_too_large", "ASSET_TOO_LARGE"],
    ["asset_type_unsupported", "ASSET_TYPE_UNSUPPORTED"],
    ["asset_type_mismatch", "ASSET_TYPE_UNSUPPORTED"],
    ["asset_idempotency_conflict", "ASSET_IDEMPOTENCY_CONFLICT"],
  ];

  for (const [code, expected] of cases) {
    const backend = makeBackend({
      importImpl: async () => {
        const error = new Error("sensitive-provider-detail");
        error.code = code;
        throw error;
      },
    });
    const toolset = createStaticWebsiteToolset({ backend, localFiles: localFiles() });
    const result = await toolset.callTool("website_asset_import", args());
    assert.deepEqual(result, { ok: false, error_code: expected });
    assert.doesNotMatch(JSON.stringify(result), /sensitive-provider-detail/);
  }

  const backend = makeBackend({
    importImpl: async () => {
      throw new Error("D:\\Private\\hero.png token=abc123");
    },
  });
  const toolset = createStaticWebsiteToolset({ backend, localFiles: localFiles() });
  const result = await toolset.callTool("website_asset_import", args());
  assert.deepEqual(result, { ok: false, error_code: "ASSET_IMPORT_FAILURE" });
  assert.doesNotMatch(JSON.stringify(result), /Private|hero|abc123/);
});

test("in-process backend adapter exposes only narrow Media Library import when composed", async () => {
  const calls = [];
  const lifecycle = {
    getProject(projectId) {
      return project(projectId);
    },
  };
  const workspace = {
    listFiles() { return []; },
    computeDigest() { return "d".repeat(64); },
  };
  const assetLibrary = {
    async importLocalAsset(request) {
      calls.push(structuredClone(request));
      return validBackendResult();
    },
    listAssets() {
      throw new Error("must not be exposed by adapter");
    },
    readManagedAsset() {
      throw new Error("must not be exposed by adapter");
    },
  };
  const adapter = createInProcessStaticBackendAdapter({
    lifecycle,
    workspace,
    validateWorkspace: async () => ({ ok: true }),
    startDevelopmentPreview: async () => ({
      preview_id: "preview-" + "a".repeat(16),
      project_id: "site-1",
      workspace_digest: "d".repeat(64),
      host: "127.0.0.1",
      port: 43123,
      token: "e".repeat(64),
      url: "http://127.0.0.1:43123/preview/" + "e".repeat(64) + "/index.html",
      close: async () => {},
    }),
    assetLibrary,
  });
  assert.equal(typeof adapter.importLocalAsset, "function");
  assert.equal("listAssets" in adapter, false);
  assert.equal("readManagedAsset" in adapter, false);

  const request = {
    project_id: "site-1",
    local_file_id: LOCAL_FILE_ID,
    expected_source: { size_bytes: 1234, modified_at: MODIFIED_AT },
    expected_content_digest: null,
    idempotency_key: "website-asset-import:" + "f".repeat(64),
  };
  const result = await adapter.importLocalAsset(request);
  assert.deepEqual(result, validBackendResult());
  assert.deepEqual(calls, [request]);
});

test("in-process backend adapter fails closed on malformed optional Media Library dependency", () => {
  const lifecycle = { getProject: (projectId) => project(projectId) };
  const workspace = {
    listFiles() { return []; },
    computeDigest() { return "d".repeat(64); },
  };
  assert.throws(
    () => createInProcessStaticBackendAdapter({
      lifecycle,
      workspace,
      validateWorkspace: async () => ({ ok: true }),
      startDevelopmentPreview: async () => ({ close: async () => {} }),
      assetLibrary: {},
    }),
    /asset_library_importLocalAsset_required/,
  );
});
