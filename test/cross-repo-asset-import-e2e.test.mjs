import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createInProcessStaticBackendAdapter,
  createRdcLocalFilesAdapter,
  createStaticWebsiteToolset,
  createWindowsStableFileCapture,
} from "../src/index.mjs";

const WINDOWS = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_INDEX = path.resolve(
  HERE,
  "..",
  "..",
  "RDC-web-build-backend",
  "src",
  "index.mjs",
);
const BACKEND_AVAILABLE = fs.existsSync(BACKEND_INDEX);

function tempRoot(label) {
  const base = fs.realpathSync.native(os.tmpdir());
  return fs.mkdtempSync(path.join(base, label));
}

function cleanup(root) {
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

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

function discoveryProvider(root) {
  return {
    async findFiles(request) {
      const entries = [];
      for (const name of fs.readdirSync(root)) {
        const candidate = path.join(root, name);
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        const extension = path.extname(name).slice(1).toLowerCase();
        if (
          request.extensions.length > 0
          && !request.extensions.includes(extension)
        ) continue;
        if (
          request.query !== ""
          && !name.toLowerCase().includes(request.query.toLowerCase())
        ) continue;
        entries.push({
          canonical_path: fs.realpathSync.native(candidate),
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          is_file: true,
          is_symlink: false,
          is_reparse_point: false,
        });
      }
      entries.sort((a, b) => a.canonical_path.localeCompare(b.canonical_path));
      return entries.slice(0, request.max_results);
    },
  };
}

function staticBackendAdapter(assetLibrary) {
  return createInProcessStaticBackendAdapter({
    lifecycle: {
      getProject(projectId) {
        return project(projectId);
      },
    },
    workspace: {
      listFiles() {
        return [];
      },
      computeDigest() {
        return "d".repeat(64);
      },
    },
    validateWorkspace: async () => ({
      ok: true,
      project_id: "site-1",
      workspace_digest: "d".repeat(64),
      findings: [],
    }),
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
}

test("real Windows Website asset import preserves exact PNG/PDF bytes retry and stale denial", {
  skip: !WINDOWS || !BACKEND_AVAILABLE,
}, async () => {
  const sourceRoot = tempRoot("rdc-ws-source-");
  const assetRoot = tempRoot("rdc-ws-assets-");
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "ascii"),
      Buffer.from([0x00, 0x1a, 0xff, 0x80, 0x0d, 0x0a]),
      Buffer.from("\n%%EOF\n", "ascii"),
    ]);
    const staleOriginal = Buffer.concat([
      png.subarray(0, 8),
      Buffer.from("STALE-ORIGINAL-0001", "ascii"),
    ]);
    const staleChanged = Buffer.concat([
      png.subarray(0, 8),
      Buffer.from("STALE-CHANGED--0001", "ascii"),
    ]);
    assert.equal(staleChanged.length, staleOriginal.length);

    const pngPath = path.join(sourceRoot, "pixel.png");
    const pdfPath = path.join(sourceRoot, "original.pdf");
    const stalePath = path.join(sourceRoot, "stale.png");
    fs.writeFileSync(pngPath, png);
    fs.writeFileSync(pdfPath, pdf);
    fs.writeFileSync(stalePath, staleOriginal);

    const { createManagedAssetLibrary } = await import(pathToFileURL(BACKEND_INDEX).href);
    const rawCapture = createWindowsStableFileCapture({
      validatePath: async (requested) => fs.promises.realpath(requested),
      maxFileBytes: 1024 * 1024,
    });
    const localFiles = createRdcLocalFilesAdapter({
      rdc: discoveryProvider(sourceRoot),
      roots: [{
        root_id: "assets",
        canonical_path: fs.realpathSync.native(sourceRoot),
      }],
      maxFileBytes: 1024 * 1024,
      rawCapture,
    });
    const library = createManagedAssetLibrary({
      rootDir: assetRoot,
      localSource: localFiles,
      projectAuthority: {
        async authorizeProjectAccess({ project_id }) {
          return {
            allowed: project_id === "site-1",
            project: {
              project_id,
              project_type: "static_web",
            },
          };
        },
      },
      maxAssetBytes: 1024 * 1024,
    });
    const toolset = createStaticWebsiteToolset({
      backend: staticBackendAdapter(library),
      localFiles,
    });

    const found = await toolset.callTool("website_local_files_find", {
      root_id: "assets",
      query: "",
      extensions: ["pdf", "png"],
      max_results: 10,
    });
    assert.equal(found.ok, true);
    assert.equal(found.files.length, 3);

    const byName = new Map(found.files.map((entry) => [entry.relative_path, entry]));
    for (const [name, expectedBytes, expectedMime] of [
      ["pixel.png", png, "image/png"],
      ["original.pdf", pdf, "application/pdf"],
    ]) {
      const discovered = byName.get(name);
      assert.ok(discovered);
      const request = {
        project_id: "site-1",
        local_file_id: discovered.local_file_id,
        size_bytes: discovered.size_bytes,
        modified_at: discovered.modified_at,
      };
      const imported = await toolset.callTool("website_asset_import", request);
      assert.equal(imported.ok, true);
      assert.equal(imported.asset.size_bytes, expectedBytes.length);
      assert.equal(imported.asset.mime_type, expectedMime);

      const managedBytes = await library.readManagedAsset(
        "site-1",
        imported.asset.asset_id,
      );
      assert.deepEqual(managedBytes, expectedBytes);

      const replay = await toolset.callTool("website_asset_import", request);
      assert.deepEqual(replay, imported);
    }

    assert.equal((await library.listAssets("site-1")).length, 2);

    const stale = byName.get("stale.png");
    assert.ok(stale);
    const staleBefore = fs.statSync(stalePath);
    fs.writeFileSync(stalePath, staleChanged);
    fs.utimesSync(stalePath, staleBefore.atime, staleBefore.mtime);

    const denied = await toolset.callTool("website_asset_import", {
      project_id: "site-1",
      local_file_id: stale.local_file_id,
      size_bytes: stale.size_bytes,
      modified_at: stale.modified_at,
    });
    assert.equal(denied.ok, false);
    assert.ok([
      "LOCAL_FILE_CHANGED",
      "ASSET_IMPORT_FAILURE",
    ].includes(denied.error_code));
    assert.equal((await library.listAssets("site-1")).length, 2);
  } finally {
    cleanup(sourceRoot);
    cleanup(assetRoot);
  }
});
