import test from "node:test";
import assert from "node:assert/strict";
import { createRdcLocalFilesAdapter } from "../src/adapters/rdc-local-files.mjs";
import {
  EXECUTABLE_WEBSITE_TOOL_NAMES,
  createStaticWebsiteToolset,
} from "../src/index.mjs";

const ROOT = "D:\\Restaurant\\Photos";

function makeRdc(entries = []) {
  const calls = [];
  return {
    calls,
    async findFiles(request) {
      calls.push(structuredClone(request));
      return structuredClone(entries);
    },
  };
}

function makeBackend() {
  const calls = [];
  return {
    calls,
    getProject(projectId) {
      calls.push(["getProject", projectId]);
      return {
        project_id: projectId,
        project_type: "static_web",
        workflow_state: "review_required",
        current_workspace_digest: "a".repeat(64),
        accepted_workspace_digest: null,
        accepted_snapshot_id: null,
        active_operation_id: "op-1",
        active_operation_revision: "1",
        operation_identity_status: "bound",
        ready_release_id: null,
        active_release_id: null,
        pending_external_transition: null,
      };
    },
    listWorkspaceFiles() { return []; },
    validateWorkspace() { return { ok: true, findings: [] }; },
    async startDevelopmentPreview() { throw new Error("not used"); },
  };
}test("adapter discovers only bounded metadata under an opaque allowed root", async () => {
  const rdc = makeRdc([
    {
      canonical_path: "D:\\Restaurant\\Photos\\hero.JPG",
      size_bytes: 120034,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
      contents: "must-not-leak",
    },
    {
      canonical_path: "D:\\Restaurant\\Photos\\gallery\\dish.png",
      size_bytes: 220034,
      modified_at: "2026-09-27T12:05:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    },
  ]);
  let idCounter = 0;
  const adapter = createRdcLocalFilesAdapter({
    rdc,
    roots: [{ root_id: "restaurant-photos", canonical_path: ROOT }],
    idFactory: () => "localfile-" + String(++idCounter).padStart(32, "x"),
  });

  const result = await adapter.findLocalFiles({
    root_id: "restaurant-photos",
    query: "",
    extensions: ["jpg", "png"],
    max_results: 10,
  });

  assert.equal(rdc.calls.length, 1);
  assert.deepEqual(rdc.calls[0], {
    root_path: ROOT,
    query: "",
    extensions: ["jpg", "png"],
    max_results: 10,
    max_scan_entries: 5000,
  });
  assert.equal(result.root_id, "restaurant-photos");
  assert.deepEqual(result.files.map((file) => file.relative_path), [
    "gallery/dish.png",
    "hero.JPG",
  ]);
  assert.ok(result.files.every((file) => /^localfile-[A-Za-z0-9_-]{32,}$/.test(file.local_file_id)));
  assert.ok(result.files.every((file) => !("canonical_path" in file)));
  assert.doesNotMatch(JSON.stringify(result), /D:\\Restaurant|must-not-leak/i);

  const resolved = adapter.resolveLocalFile(result.files[0].local_file_id);
  assert.equal(resolved.root_id, "restaurant-photos");
  assert.match(resolved.canonical_path, /^D:\\Restaurant\\Photos\\/);
  assert.equal(adapter.resolveLocalFile("localfile-unknown"), null);
});test("adapter rejects unknown roots before touching RDC", async () => {
  const rdc = makeRdc();
  const adapter = createRdcLocalFilesAdapter({
    rdc,
    roots: [{ root_id: "restaurant-photos", canonical_path: ROOT }],
  });
  await assert.rejects(
    () => adapter.findLocalFiles({
      root_id: "other-root",
      query: "",
      extensions: [],
      max_results: 10,
    }),
    /local_file_root_unavailable/,
  );
  assert.equal(rdc.calls.length, 0);
});

test("adapter rejects unsafe root configuration", () => {
  const rdc = makeRdc();
  for (const roots of [
    [{ root_id: "../bad", canonical_path: ROOT }],
    [{ root_id: "photos", canonical_path: "relative\\path" }],
    [{ root_id: "photos", canonical_path: "\\\\server\\share" }],
    [
      { root_id: "photos", canonical_path: ROOT },
      { root_id: "photos", canonical_path: "E:\\Other" },
    ],
  ]) {
    assert.throws(() => createRdcLocalFilesAdapter({ rdc, roots }), /local_file_root_invalid/);
  }
});test("adapter fails closed on out-of-root, symlink/reparse and malformed provider entries", async () => {
  const badEntries = [
    { canonical_path: "D:\\Restaurant\\escape.jpg", size_bytes: 1, modified_at: "2026-09-27T12:00:00Z", is_file: true, is_symlink: false, is_reparse_point: false },
    { canonical_path: "D:\\Restaurant\\Photos\\link.jpg", size_bytes: 1, modified_at: "2026-09-27T12:00:00Z", is_file: true, is_symlink: true, is_reparse_point: false },
    { canonical_path: "D:\\Restaurant\\Photos\\reparse.jpg", size_bytes: 1, modified_at: "2026-09-27T12:00:00Z", is_file: true, is_symlink: false, is_reparse_point: true },
    { canonical_path: "D:\\Restaurant\\Photos\\folder", size_bytes: 1, modified_at: "2026-09-27T12:00:00Z", is_file: false, is_symlink: false, is_reparse_point: false },
    { canonical_path: "D:\\Restaurant\\Photos\\huge.jpg", size_bytes: 100_000_000, modified_at: "2026-09-27T12:00:00Z", is_file: true, is_symlink: false, is_reparse_point: false },
    { canonical_path: "D:\\Restaurant\\Photos\\bad.jpg", size_bytes: -1, modified_at: "not-a-date", is_file: true, is_symlink: false, is_reparse_point: false },
  ];
  for (const entry of badEntries) {
    const adapter = createRdcLocalFilesAdapter({
      rdc: makeRdc([entry]),
      roots: [{ root_id: "photos", canonical_path: ROOT }],
      maxFileBytes: 50_000_000,
    });
    await assert.rejects(
      () => adapter.findLocalFiles({ root_id: "photos", query: "", extensions: [], max_results: 10 }),
      /local_file_source_invalid/,
    );
  }
});test("adapter treats Windows containment case-insensitively and deduplicates identity", async () => {
  const rdc = makeRdc([
    {
      canonical_path: "d:\\restaurant\\photos\\Hero.jpg",
      size_bytes: 10,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    },
    {
      canonical_path: "D:\\Restaurant\\Photos\\hero.jpg",
      size_bytes: 10,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    },
  ]);
  const adapter = createRdcLocalFilesAdapter({
    rdc,
    roots: [{ root_id: "photos", canonical_path: ROOT }],
  });
  const result = await adapter.findLocalFiles({
    root_id: "photos",
    query: "",
    extensions: ["jpg"],
    max_results: 10,
  });
  assert.equal(result.files.length, 1);
  const again = await adapter.findLocalFiles({
    root_id: "photos",
    query: "",
    extensions: ["jpg"],
    max_results: 10,
  });
  assert.equal(again.files[0].local_file_id, result.files[0].local_file_id);
});test("tool is advertised only when local file adapter is composed", async () => {
  const backend = makeBackend();
  const withoutLocal = createStaticWebsiteToolset({ backend });
  assert.equal(withoutLocal.tools.some((tool) => tool.name === "website_local_files_find"), false);
  assert.deepEqual(
    await withoutLocal.callTool("website_local_files_find", {
      root_id: "photos",
      query: "",
      extensions: [],
      max_results: 10,
    }),
    { ok: false, error_code: "CAPABILITY_UNAVAILABLE" },
  );

  const localFiles = createRdcLocalFilesAdapter({
    rdc: makeRdc([{
      canonical_path: "D:\\Restaurant\\Photos\\hero.jpg",
      size_bytes: 42,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    }]),
    roots: [{ root_id: "photos", canonical_path: ROOT }],
  });
  const toolset = createStaticWebsiteToolset({ backend, localFiles });
  assert.equal(toolset.tools.some((tool) => tool.name === "website_local_files_find"), true);
  assert.ok(EXECUTABLE_WEBSITE_TOOL_NAMES.includes("website_local_files_find"));

  const result = await toolset.callTool("website_local_files_find", {
    root_id: "photos",
    query: "hero",
    extensions: ["jpg"],
    max_results: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.root_id, "photos");
  assert.equal(result.files.length, 1);
  assert.equal(backend.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /D:\\Restaurant/i);
});test("tool request is closed and cannot inject paths or authority", async () => {
  const backend = makeBackend();
  const localFiles = {
    async findLocalFiles() {
      throw new Error("must not be called");
    },
  };
  const toolset = createStaticWebsiteToolset({ backend, localFiles });
  for (const args of [
    { root_id: "photos", query: "", extensions: [], max_results: 10, root_path: ROOT },
    { root_id: "photos", query: "", extensions: [], max_results: 10, caller_class: "trusted_control_plane" },
    { root_id: "../photos", query: "", extensions: [], max_results: 10 },
    { root_id: "photos", query: "x".repeat(129), extensions: [], max_results: 10 },
    { root_id: "photos", query: "", extensions: [".jpg"], max_results: 10 },
    { root_id: "photos", query: "", extensions: [], max_results: 0 },
    { root_id: "photos", query: "", extensions: [], max_results: 51 },
  ]) {
    assert.deepEqual(
      await toolset.callTool("website_local_files_find", args),
      { ok: false, error_code: "REQUEST_INVALID" },
    );
  }
});test("tool re-sanitizes local adapter output and never leaks provider fields", async () => {
  const backend = makeBackend();
  const localFiles = {
    async findLocalFiles() {
      return {
        root_id: "photos",
        files: [{
          local_file_id: "localfile-" + "x".repeat(32),
          relative_path: "hero.jpg",
          size_bytes: 42,
          extension: "jpg",
          modified_at: "2026-09-27T12:00:00.000Z",
          canonical_path: ROOT + "\\hero.jpg",
          contents: "secret-bytes",
        }],
      };
    },
  };
  const toolset = createStaticWebsiteToolset({ backend, localFiles });
  const result = await toolset.callTool("website_local_files_find", {
    root_id: "photos",
    query: "",
    extensions: [],
    max_results: 10,
  });
  assert.deepEqual(result, {
    ok: true,
    root_id: "photos",
    files: [{
      local_file_id: "localfile-" + "x".repeat(32),
      relative_path: "hero.jpg",
      size_bytes: 42,
      extension: "jpg",
      modified_at: "2026-09-27T12:00:00.000Z",
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /canonical|secret|D:\\Restaurant/i);
});

test("tool sanitizes provider exceptions", async () => {
  const toolset = createStaticWebsiteToolset({
    backend: makeBackend(),
    localFiles: {
      async findLocalFiles() {
        throw new Error("C:\\Users\\private\\secret token=abc");
      },
    },
  });
  const result = await toolset.callTool("website_local_files_find", {
    root_id: "photos",
    query: "",
    extensions: [],
    max_results: 10,
  });
  assert.deepEqual(result, { ok: false, error_code: "LOCAL_FILE_SOURCE_FAILURE" });
  assert.doesNotMatch(JSON.stringify(result), /Users|secret|abc/);
});test("adapter validates direct discovery requests before RDC", async () => {
  const invalid = [
    { root_id: "photos", query: "", extensions: [], max_results: 10, extra: true },
    { root_id: "../photos", query: "", extensions: [], max_results: 10 },
    { root_id: "photos", query: "folder/name", extensions: [], max_results: 10 },
    { root_id: "photos", query: "folder\\name", extensions: [], max_results: 10 },
    { root_id: "photos", query: "bad\0name", extensions: [], max_results: 10 },
    { root_id: "photos", query: "x".repeat(129), extensions: [], max_results: 10 },
    { root_id: "photos", query: "", extensions: [".jpg"], max_results: 10 },
    { root_id: "photos", query: "", extensions: ["jpg", "JPG"], max_results: 10 },
    { root_id: "photos", query: "", extensions: Array.from({ length: 17 }, (_, i) => "x" + i), max_results: 10 },
    { root_id: "photos", query: "", extensions: [], max_results: 0 },
    { root_id: "photos", query: "", extensions: [], max_results: 51 },
    { root_id: "photos", query: "", extensions: [], max_results: 1.5 },
  ];
  for (const request of invalid) {
    const rdc = makeRdc();
    const adapter = createRdcLocalFilesAdapter({
      rdc,
      roots: [{ root_id: "photos", canonical_path: ROOT }],
    });
    await assert.rejects(() => adapter.findLocalFiles(request), /local_file_request_invalid/);
    assert.equal(rdc.calls.length, 0);
  }
});test("provider filtering is revalidated instead of trusted", async () => {
  const base = {
    size_bytes: 10,
    modified_at: "2026-09-27T12:00:00.000Z",
    is_file: true,
    is_symlink: false,
    is_reparse_point: false,
  };
  const cases = [
    [
      [
        { ...base, canonical_path: ROOT + "\\hero.jpg" },
        { ...base, canonical_path: ROOT + "\\hero2.jpg" },
      ],
      { root_id: "photos", query: "hero", extensions: ["jpg"], max_results: 1 },
      /local_file_source_invalid/,
    ],
    [
      [{ ...base, canonical_path: ROOT + "\\hero.png" }],
      { root_id: "photos", query: "hero", extensions: ["jpg"], max_results: 5 },
      /local_file_source_invalid/,
    ],
    [
      [{ ...base, canonical_path: ROOT + "\\dish.jpg" }],
      { root_id: "photos", query: "hero", extensions: ["jpg"], max_results: 5 },
      /local_file_source_invalid/,
    ],
  ];
  for (const [entries, request, expected] of cases) {
    const adapter = createRdcLocalFilesAdapter({
      rdc: makeRdc(entries),
      roots: [{ root_id: "photos", canonical_path: ROOT }],
    });
    await assert.rejects(() => adapter.findLocalFiles(request), expected);
  }
});test("strict Windows canonical paths reject substitution forms", async () => {
  const badPaths = [
    ROOT,
    ROOT + "\\..\\escape.jpg",
    ROOT + "\\.\\file.jpg",
    "D:\\Restaurant\\PhotosX\\file.jpg",
    ROOT + "\\nested\\\\file.jpg",
    ROOT + "\\file.jpg:stream",
    ROOT + "\\trail.\\file.jpg",
    ROOT + "\\trail \\file.jpg",
    ROOT + "\\CON.jpg",
    ROOT + "\\CONIN$",
    ROOT + "\\CONOUT$",
    ROOT + "\\COM¹.txt",
    ROOT + "\\LPT².png",
    ROOT + "\\LPT³.jpg",
    ROOT + "/mixed/file.jpg",
    "\\\\?\\D:\\Restaurant\\Photos\\file.jpg",
    "\\.\\D:\\Restaurant\\Photos\\file.jpg",
    "\\\\server\\share\\file.jpg",
  ];
  for (const canonical_path of badPaths) {
    const adapter = createRdcLocalFilesAdapter({
      rdc: makeRdc([{
        canonical_path,
        size_bytes: 10,
        modified_at: "2026-09-27T12:00:00.000Z",
        is_file: true,
        is_symlink: false,
        is_reparse_point: false,
      }]),
      roots: [{ root_id: "photos", canonical_path: ROOT }],
    });
    await assert.rejects(
      () => adapter.findLocalFiles({ root_id: "photos", query: "", extensions: [], max_results: 5 }),
      /local_file_source_invalid/,
    );
  }
});test("root configuration is canonical, case-unique and immutable", async () => {
  const rdc = makeRdc([{
    canonical_path: ROOT + "\\hero.jpg",
    size_bytes: 10,
    modified_at: "2026-09-27T12:00:00.000Z",
    is_file: true,
    is_symlink: false,
    is_reparse_point: false,
  }]);
  for (const canonical_path of [
    "D:\\Restaurant\\Photos\\..\\Other",
    "D:\\Restaurant\\Photos\\.",
    "D:\\Restaurant\\Trail. ",
    "D:\\Restaurant\\Photos:ads",
    "\\\\?\\D:\\Restaurant\\Photos",
    "\\\\server\\share",
    "D:/Restaurant/Photos",
  ]) {
    assert.throws(
      () => createRdcLocalFilesAdapter({
        rdc,
        roots: [{ root_id: "photos", canonical_path }],
      }),
      /local_file_root_invalid/,
    );
  }
  assert.throws(
    () => createRdcLocalFilesAdapter({
      rdc,
      roots: [
        { root_id: "Photos", canonical_path: ROOT },
        { root_id: "photos", canonical_path: "E:\\Other" },
      ],
    }),
    /local_file_root_invalid/,
  );

  const roots = [{ root_id: "photos", canonical_path: ROOT }];
  const adapter = createRdcLocalFilesAdapter({ rdc, roots });
  roots[0].canonical_path = "E:\\Other";
  const result = await adapter.findLocalFiles({
    root_id: "photos",
    query: "",
    extensions: [],
    max_results: 5,
  });
  assert.equal(result.files.length, 1);
  assert.equal(rdc.calls[0].root_path, ROOT);
});test("provider response types and metadata are strict", async () => {
  const good = {
    canonical_path: ROOT + "\\hero.jpg",
    size_bytes: 10,
    modified_at: "2026-09-27T12:00:00.000Z",
    is_file: true,
    is_symlink: false,
    is_reparse_point: false,
  };
  const invalidResponses = [
    null,
    {},
    "not-array",
    [{ ...good, size_bytes: "10" }],
    [{ ...good, size_bytes: 1.5 }],
    [{ ...good, modified_at: "2026-09-27" }],
    [{ ...good, modified_at: "09/27/2026 12:00" }],
    [{ ...good, is_file: 1 }],
    [{ ...good, is_symlink: undefined }],
    [{ ...good, is_reparse_point: undefined }],
  ];
  for (const response of invalidResponses) {
    const rdc = {
      calls: [],
      async findFiles(request) {
        this.calls.push(request);
        return response;
      },
    };
    const adapter = createRdcLocalFilesAdapter({
      rdc,
      roots: [{ root_id: "photos", canonical_path: ROOT }],
    });
    await assert.rejects(
      () => adapter.findLocalFiles({ root_id: "photos", query: "", extensions: [], max_results: 5 }),
      /local_file_source_invalid/,
    );
  }
});test("opaque ID collisions fail closed without aliasing identities", async () => {
  const entries = [
    {
      canonical_path: ROOT + "\\a.jpg",
      size_bytes: 10,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    },
    {
      canonical_path: ROOT + "\\b.jpg",
      size_bytes: 10,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    },
  ];
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeRdc(entries),
    roots: [{ root_id: "photos", canonical_path: ROOT }],
    idFactory: () => "localfile-" + "x".repeat(32),
  });
  await assert.rejects(
    () => adapter.findLocalFiles({ root_id: "photos", query: "", extensions: ["jpg"], max_results: 5 }),
    /local_file_id_collision/,
  );
  assert.equal(adapter.resolveLocalFile("localfile-" + "x".repeat(32)), null);
});test("adapter sanitizes RDC failures at its own boundary", async () => {
  const adapter = createRdcLocalFilesAdapter({
    rdc: {
      async findFiles() {
        throw new Error("D:\\Private\\secret.jpg token=abc123");
      },
    },
    roots: [{ root_id: "photos", canonical_path: ROOT }],
  });
  await assert.rejects(
    () => adapter.findLocalFiles({ root_id: "photos", query: "", extensions: [], max_results: 5 }),
    (error) => {
      assert.equal(error.code, "local_file_source_failure");
      assert.equal(error.message, "local_file_source_failure");
      assert.equal("cause" in error, false);
      assert.doesNotMatch(JSON.stringify(error), /Private|secret|abc123/);
      return true;
    },
  );
});test("query semantics are basename-only ASCII-insensitive substring matching", async () => {
  const rdc = makeRdc([
    {
      canonical_path: ROOT + "\\gallery\\Hero-Shot.JPG",
      size_bytes: 10,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    },
  ]);
  const adapter = createRdcLocalFilesAdapter({
    rdc,
    roots: [{ root_id: "photos", canonical_path: ROOT }],
  });
  const yes = await adapter.findLocalFiles({
    root_id: "photos",
    query: "hero-shot",
    extensions: ["jpg"],
    max_results: 5,
  });
  assert.equal(yes.files.length, 1);
  await assert.rejects(
    () => adapter.findLocalFiles({
      root_id: "photos",
      query: "gallery",
      extensions: ["jpg"],
      max_results: 5,
    }),
    /local_file_source_invalid/,
  );
});test("adapter output projection is exact even with arbitrary RDC metadata", async () => {
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeRdc([{
      canonical_path: ROOT + "\\hero.jpg",
      size_bytes: 10,
      modified_at: "2026-09-27T12:00:00.000Z",
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
      owner: "private-user",
      contents: "secret",
    }]),
    roots: [{ root_id: "photos", canonical_path: ROOT }],
  });
  const result = await adapter.findLocalFiles({
    root_id: "photos",
    query: "",
    extensions: ["jpg"],
    max_results: 5,
  });
  assert.deepEqual(Object.keys(result).sort(), ["files", "root_id"]);
  assert.deepEqual(Object.keys(result.files[0]).sort(), [
    "extension",
    "local_file_id",
    "modified_at",
    "relative_path",
    "size_bytes",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-user|secret|canonical_path/i);
});test("local files schema matches runtime validation", () => {
  const backend = makeBackend();
  const localFiles = {
    async findLocalFiles() {
      return { root_id: "photos", files: [] };
    },
  };
  const toolset = createStaticWebsiteToolset({ backend, localFiles });
  const tool = toolset.tools.find((entry) => entry.name === "website_local_files_find");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["root_id", "query", "extensions", "max_results"]);
  assert.equal(tool.inputSchema.properties.root_id.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  assert.equal(tool.inputSchema.properties.query.maxLength, 128);
  assert.equal(tool.inputSchema.properties.extensions.maxItems, 16);
  assert.equal(tool.inputSchema.properties.max_results.maximum, 50);
});
test("adapter sanitizes provider entry accessors and proxies after RDC returns", async () => {
  const throwingEntry = {
    canonical_path: ROOT + "\\hero.jpg",
    size_bytes: 10,
    modified_at: "2026-09-27T12:00:00.000Z",
    is_symlink: false,
    is_reparse_point: false,
  };
  Object.defineProperty(throwingEntry, "is_file", {
    enumerable: true,
    get() {
      throw new Error("D:\\Private\\secret.jpg token=abc123");
    },
  });

  for (const response of [
    [throwingEntry],
    [new Proxy({}, {
      getPrototypeOf() {
        throw new Error("D:\\Private\\proxy-secret token=xyz");
      },
    })],
  ]) {
    const adapter = createRdcLocalFilesAdapter({
      rdc: {
        async findFiles() {
          return response;
        },
      },
      roots: [{ root_id: "photos", canonical_path: ROOT }],
    });
    await assert.rejects(
      () => adapter.findLocalFiles({
        root_id: "photos",
        query: "",
        extensions: [],
        max_results: 5,
      }),
      (error) => {
        assert.equal(error.code, "local_file_source_failure");
        assert.equal(error.message, "local_file_source_failure");
        assert.equal("cause" in error, false);
        assert.doesNotMatch(JSON.stringify(error), /Private|secret|abc123|xyz/);
        return true;
      },
    );
  }
});

test("tool projection rejects Windows ADS and superscript device names from a composed adapter", async () => {
  for (const relative_path of [
    "hero:secret.jpg",
    "folder/COM¹.txt",
    "folder/LPT².png",
    "LPT³.jpg",
  ]) {
    const dot = relative_path.lastIndexOf(".");
    const extension = dot > 0 ? relative_path.slice(dot + 1).toLowerCase() : "";
    const toolset = createStaticWebsiteToolset({
      backend: makeBackend(),
      localFiles: {
        async findLocalFiles() {
          return {
            root_id: "photos",
            files: [{
              local_file_id: "localfile-" + "x".repeat(32),
              relative_path,
              size_bytes: 42,
              extension,
              modified_at: "2026-09-27T12:00:00.000Z",
            }],
          };
        },
      },
    });
    const result = await toolset.callTool("website_local_files_find", {
      root_id: "photos",
      query: "",
      extensions: [],
      max_results: 10,
    });
    assert.deepEqual(result, { ok: false, error_code: "LOCAL_FILE_SOURCE_INVALID" });
    assert.doesNotMatch(JSON.stringify(result), /secret|COM¹|LPT²|LPT³/);
  }
});

test("runtime toolset status reflects composed local-files capability", () => {
  const backend = makeBackend();
  const withoutLocal = createStaticWebsiteToolset({ backend });
  assert.equal(withoutLocal.status.local_files_composed, false);
  assert.equal(
    withoutLocal.status.executable_tool_names.includes("website_local_files_find"),
    false,
  );

  const withLocal = createStaticWebsiteToolset({
    backend,
    localFiles: {
      async findLocalFiles() {
        return { root_id: "photos", files: [] };
      },
    },
  });
  assert.equal(withLocal.status.local_files_composed, true);
  assert.equal(
    withLocal.status.executable_tool_names.includes("website_local_files_find"),
    true,
  );
  assert.deepEqual(
    withLocal.status.executable_tool_names,
    withLocal.tools.map((tool) => tool.name),
  );
});
