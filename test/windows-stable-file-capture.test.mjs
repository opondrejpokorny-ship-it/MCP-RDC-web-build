import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createRdcLocalFilesAdapter } from "../src/adapters/rdc-local-files.mjs";
import { createWindowsStableFileCapture } from "../src/adapters/windows-stable-file-capture.mjs";

const WINDOWS = process.platform === "win32";

function tempRoot() {
  const base = fs.realpathSync.native(os.tmpdir());
  return fs.mkdtempSync(path.join(base, "rdc-ws-raw-"));
}

function cleanup(root) {
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

function digest(bytes) {
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

function realValidator(requested) {
  return fs.promises.realpath(requested);
}

function entryFor(file) {
  const stat = fs.statSync(file);
  return {
    canonical_path: fs.realpathSync.native(file),
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    is_file: stat.isFile(),
    is_symlink: false,
    is_reparse_point: false,
  };
}

function discoveryRdc(file) {
  return {
    async findFiles() {
      return [entryFor(file)];
    },
  };
}

async function discover(adapter, extension = "bin") {
  const result = await adapter.findLocalFiles({
    root_id: "root",
    query: "",
    extensions: [extension],
    max_results: 5,
  });
  assert.equal(result.files.length, 1);
  return result.files[0];
}

test("real Windows helper captures exact original bytes digest identity and Node mtime", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "probe.bin");
    const bytes = Buffer.from([0, 1, 2, 3, 255, 10, 13, 26, 128, 64]);
    fs.writeFileSync(file, bytes);
    const canonical = fs.realpathSync.native(file);
    const rootCanonical = fs.realpathSync.native(root);
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 1024,
    });

    const actual = await capture.captureFile({
      canonical_path: canonical,
      root_path: rootCanonical,
      include_bytes: true,
    });

    assert.deepEqual(actual.bytes, bytes);
    assert.equal(actual.content_digest, digest(bytes));
    assert.equal(actual.size_bytes, bytes.length);
    assert.equal(actual.modified_at, fs.statSync(file).mtime.toISOString());
    assert.match(actual.source_identity, /^win32:[a-f0-9]{8}:[a-f0-9]{16}$/);
    assert.equal(actual.hard_link_count, 1);
  } finally {
    cleanup(root);
  }
});

test("real Windows helper rejects a hard-link alias", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "original.bin");
    const alias = path.join(root, "alias.bin");
    fs.writeFileSync(file, Buffer.from("same-object"));
    fs.linkSync(file, alias);
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 1024,
    });

    await assert.rejects(
      () => capture.captureFile({
        canonical_path: fs.realpathSync.native(file),
        root_path: fs.realpathSync.native(root),
        include_bytes: false,
      }),
      /local_file_source_failure/,
    );
  } finally {
    cleanup(root);
  }
});

test("real Windows bridge rejects a junction redirect before capture", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    const target = path.join(outside, "foreign.bin");
    fs.writeFileSync(target, Buffer.from("foreign"));
    const junction = path.join(root, "redirect");
    fs.symlinkSync(outside, junction, "junction");
    const candidate = path.join(junction, "foreign.bin");
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 1024,
    });

    await assert.rejects(
      () => capture.captureFile({
        canonical_path: candidate,
        root_path: fs.realpathSync.native(root),
        include_bytes: false,
      }),
      /local_file_source_invalid/,
    );
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test("real Windows bridge detects same-size same-mtime pathname replacement", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "replace.bin");
    const original = Buffer.from("AAAA1111");
    const replacement = Buffer.from("BBBB2222");
    fs.writeFileSync(file, original);
    const originalStat = fs.statSync(file);
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 1024,
    });
    const adapter = createRdcLocalFilesAdapter({
      rdc: discoveryRdc(file),
      roots: [{ root_id: "root", canonical_path: fs.realpathSync.native(root) }],
      rawCapture: capture,
    });
    const discovered = await discover(adapter);

    fs.unlinkSync(file);
    fs.writeFileSync(file, replacement);
    fs.utimesSync(file, originalStat.atime, originalStat.mtime);

    await assert.rejects(
      () => adapter.statLocalFile(discovered.local_file_id),
      /local_file_source_changed/,
    );
  } finally {
    cleanup(root);
  }
});

test("real Windows bridge detects same-object content ABA with restored mtime", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "aba.bin");
    const original = Buffer.from("AAAA1111");
    const changed = Buffer.from("BBBB2222");
    fs.writeFileSync(file, original);
    const originalStat = fs.statSync(file);
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 1024,
    });
    const adapter = createRdcLocalFilesAdapter({
      rdc: discoveryRdc(file),
      roots: [{ root_id: "root", canonical_path: fs.realpathSync.native(root) }],
      rawCapture: capture,
    });
    const discovered = await discover(adapter);

    fs.writeFileSync(file, changed);
    fs.utimesSync(file, originalStat.atime, originalStat.mtime);

    await assert.rejects(
      () => adapter.statLocalFile(discovered.local_file_id),
      /local_file_source_changed/,
    );
  } finally {
    cleanup(root);
  }
});

test("real Windows capture denies write and rename while handle is active then releases", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "locked.bin");
    const renamed = path.join(root, "renamed.bin");
    fs.writeFileSync(file, Buffer.alloc(256 * 1024, 7));
    const canonical = fs.realpathSync.native(file);
    const rootCanonical = fs.realpathSync.native(root);
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 1024 * 1024,
      helperHoldOpenMs: 2500,
    });

    const pending = capture.captureFile({
      canonical_path: canonical,
      root_path: rootCanonical,
      include_bytes: false,
    });

    let locked = false;
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(file, "r+");
        fs.closeSync(fd);
      } catch {
        locked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(locked, true, "capture handle never denied write sharing");

    assert.throws(() => fs.renameSync(file, renamed));
    await pending;

    const fd = fs.openSync(file, "r+");
    fs.closeSync(fd);
    fs.renameSync(file, renamed);
    fs.renameSync(renamed, file);
  } finally {
    cleanup(root);
  }
});

test("real Windows helper fails closed when source exceeds configured size", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "large.bin");
    fs.writeFileSync(file, Buffer.alloc(32, 1));
    const capture = createWindowsStableFileCapture({
      validatePath: realValidator,
      maxFileBytes: 16,
    });
    await assert.rejects(
      () => capture.captureFile({
        canonical_path: fs.realpathSync.native(file),
        root_path: fs.realpathSync.native(root),
        include_bytes: true,
      }),
      /local_file_source_failure/,
    );
  } finally {
    cleanup(root);
  }
});

test("real Windows provider rejects device and reserved path forms before helper execution", { skip: !WINDOWS }, async () => {
  const root = tempRoot();
  try {
    const capture = createWindowsStableFileCapture({
      validatePath: async (requested) => requested,
      maxFileBytes: 1024,
      runCapture: async () => {
        throw new Error("must-not-run");
      },
    });
    const rootCanonical = fs.realpathSync.native(root);
    for (const candidate of [
      "\\\\.\\NUL",
      rootCanonical + "\\NUL",
      rootCanonical + "\\CONIN$",
      rootCanonical + "\\CONOUT$",
      rootCanonical + "\\COM1.txt",
    ]) {
      await assert.rejects(
        () => capture.captureFile({
          canonical_path: candidate,
          root_path: rootCanonical,
          include_bytes: false,
        }),
        /local_file_source_invalid/,
      );
    }
  } finally {
    cleanup(root);
  }
});
