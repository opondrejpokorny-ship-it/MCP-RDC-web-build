import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createRdcLocalFilesAdapter } from "../src/adapters/rdc-local-files.mjs";
import { createWindowsStableFileCapture } from "../src/adapters/windows-stable-file-capture.mjs";

const ROOT = "D:\\Restaurant\\Photos";
const FILE = ROOT + "\\hero.png";
const MODIFIED_AT = "2026-09-29T12:34:56.789Z";
const BYTES = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
const DIGEST = "sha256:" + crypto.createHash("sha256").update(BYTES).digest("hex");
const SOURCE_ID = "win32:1234abcd:0000000000000042";

function makeDiscoveryRdc(overrides = {}) {
  return { async findFiles() { return [{
    canonical_path: FILE, size_bytes: BYTES.length, modified_at: MODIFIED_AT,
    is_file: true, is_symlink: false, is_reparse_point: false, ...overrides,
  }]; } };
}

function normalizedCapture(overrides = {}) {
  return {
    canonical_path: FILE, source_identity: SOURCE_ID, size_bytes: BYTES.length,
    modified_at: MODIFIED_AT, content_digest: DIGEST, hard_link_count: 1,
    is_file: true, is_symlink: false, is_reparse_point: false,
    bytes: Buffer.from(BYTES), ...overrides,
  };
}

function fakeCapture(sequence = [normalizedCapture()]) {
  const calls = []; let index = 0;
  return {
    calls,
    async captureFile(request) {
      calls.push(structuredClone(request));
      const value = sequence[Math.min(index++, sequence.length - 1)];
      if (value instanceof Error) throw value;
      return { ...value, bytes: value.bytes === null ? null : Buffer.from(value.bytes) };
    },
  };
}

test("stable capture requires stock path validation and exact root containment", async () => {
  const validations = []; const runnerCalls = [];
  const capture = createWindowsStableFileCapture({
    validatePath: async (requested) => { validations.push(requested); return requested; },
    maxFileBytes: 1024,
    runCapture: async (request) => { runnerCalls.push(structuredClone(request)); return normalizedCapture(); },
  });
  const result = await capture.captureFile({ canonical_path: FILE, root_path: ROOT, include_bytes: true });
  assert.deepEqual(validations, [FILE]);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].canonical_path, FILE);
  assert.equal(runnerCalls[0].max_bytes, 1024);
  assert.equal(runnerCalls[0].include_bytes, true);
  assert.equal(result.source_identity, SOURCE_ID);
  assert.equal(result.content_digest, DIGEST);
  assert.deepEqual(result.bytes, BYTES);
});

test("stable capture rejects validator resolution drift and root escape before raw read", async () => {
  for (const validated of ["D:\\Restaurant\\Other\\hero.png","D:\\Restaurant\\Photos\\link-target.png"]) {
    let runnerCalled = false;
    const capture = createWindowsStableFileCapture({
      validatePath: async () => validated, maxFileBytes: 1024,
      runCapture: async () => { runnerCalled = true; return normalizedCapture(); },
    });
    await assert.rejects(
      () => capture.captureFile({ canonical_path: FILE, root_path: ROOT, include_bytes: false }),
      /local_file_source_invalid/,
    );
    assert.equal(runnerCalled, false);
  }
});

test("stable capture does not Unicode-fold distinct canonical paths", async () => {
  let runnerCalled = false;
  const capture = createWindowsStableFileCapture({
    validatePath: async () => "D:\\Restaurant\\Photos\\K.png",
    maxFileBytes: 1024,
    runCapture: async () => {
      runnerCalled = true;
      return normalizedCapture();
    },
  });
  await assert.rejects(
    () => capture.captureFile({
      canonical_path: "D:\\Restaurant\\Photos\\K.png",
      root_path: ROOT,
      include_bytes: false,
    }),
    /local_file_source_invalid/,
  );
  assert.equal(runnerCalled, false);
});
test("stable capture rejects hard links reparse substitution and malformed opened identity", async () => {
  const bad = [
    { hard_link_count: 2 }, { is_reparse_point: true }, { is_file: false },
    { source_identity: "bad" }, { canonical_path: "D:\\Restaurant\\Photos\\other.png" },
    { modified_at: "2026-09-29T12:34:56Z" }, { size_bytes: -1 }, { content_digest: "sha256:bad" },
  ];
  for (const override of bad) {
    const capture = createWindowsStableFileCapture({
      validatePath: async (requested) => requested, maxFileBytes: 1024,
      runCapture: async () => normalizedCapture(override),
    });
    await assert.rejects(
      () => capture.captureFile({ canonical_path: FILE, root_path: ROOT, include_bytes: true }),
      /local_file_source_invalid/,
    );
  }
});

test("stable capture independently verifies returned byte length and digest", async () => {
  for (const override of [
    { size_bytes: BYTES.length + 1 },
    { bytes: Buffer.from("foreign-bytes") },
    { content_digest: "sha256:" + "f".repeat(64) },
  ]) {
    const capture = createWindowsStableFileCapture({
      validatePath: async (requested) => requested, maxFileBytes: 1024,
      runCapture: async () => normalizedCapture(override),
    });
    await assert.rejects(
      () => capture.captureFile({ canonical_path: FILE, root_path: ROOT, include_bytes: true }),
      /local_file_source_invalid/,
    );
  }
});

test("stable capture enforces configured bounds", async () => {
  const capture = createWindowsStableFileCapture({
    validatePath: async (requested) => requested,
    maxFileBytes: BYTES.length - 1,
    runCapture: async () => normalizedCapture(),
  });
  await assert.rejects(
    () => capture.captureFile({ canonical_path: FILE, root_path: ROOT, include_bytes: true }),
    /local_file_source_invalid/,
  );
});

test("stable capture sanitizes validator and provider failures", async () => {
  const cases = [
    createWindowsStableFileCapture({
      validatePath: async () => { throw new Error("C:\\Users\\private\\secret.png token=abc"); },
      maxFileBytes: 1024, runCapture: async () => normalizedCapture(),
    }),
    createWindowsStableFileCapture({
      validatePath: async (requested) => requested, maxFileBytes: 1024,
      runCapture: async () => { throw new Error("D:\\Private\\secret.pdf bearer=xyz"); },
    }),
  ];
  for (const capture of cases) {
    await assert.rejects(
      () => capture.captureFile({ canonical_path: FILE, root_path: ROOT, include_bytes: false }),
      (error) => {
        assert.equal(error.code, "local_file_source_failure");
        assert.equal(error.message, "local_file_source_failure");
        assert.doesNotMatch(JSON.stringify(error), /Users|Private|secret|abc|xyz/i);
        return true;
      },
    );
  }
});

test("discovery binds private identity and digest without model leakage", async () => {
  const rawCapture = fakeCapture([normalizedCapture({ bytes: null })]);
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "photos", canonical_path: ROOT }],
    rawCapture, idFactory: () => "localfile-" + "x".repeat(32),
  });
  const result = await adapter.findLocalFiles({ root_id: "photos", query: "hero", extensions: ["png"], max_results: 5 });
  assert.equal(result.files.length, 1);
  assert.deepEqual(Object.keys(result.files[0]).sort(), ["extension","local_file_id","modified_at","relative_path","size_bytes"]);
  assert.doesNotMatch(JSON.stringify(result), /source_identity|content_digest|win32|sha256|Restaurant/i);
  assert.deepEqual(adapter.getLocalFileImportBinding(result.files[0].local_file_id), {
    size_bytes: BYTES.length, modified_at: MODIFIED_AT, content_digest: DIGEST,
  });
  const resolved = adapter.resolveLocalFile(result.files[0].local_file_id);
  assert.equal(resolved.source_identity, SOURCE_ID);
  assert.equal(resolved.content_digest, DIGEST);
  assert.equal(rawCapture.calls[0].include_bytes, false);
});

test("backend stat-read-stat uses one exact atomic capture", async () => {
  const rawCapture = fakeCapture([normalizedCapture({ bytes: null }), normalizedCapture()]);
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "photos", canonical_path: ROOT }],
    rawCapture, idFactory: () => "localfile-" + "y".repeat(32),
  });
  const discovery = await adapter.findLocalFiles({ root_id: "photos", query: "", extensions: ["png"], max_results: 5 });
  const id = discovery.files[0].local_file_id;
  const before = await adapter.statLocalFile(id);
  const bytes = await adapter.readLocalFile(id);
  const after = await adapter.statLocalFile(id);
  assert.deepEqual(bytes, BYTES);
  assert.deepEqual(after, before);
  assert.equal(before.source_identity, SOURCE_ID);
  assert.equal(before.relative_path, "hero.png");
  assert.equal(rawCapture.calls.length, 2);
  assert.equal(rawCapture.calls[1].include_bytes, true);
});

test("same-size same-mtime replacement fails on opened identity", async () => {
  const rawCapture = fakeCapture([
    normalizedCapture({ bytes: null }),
    normalizedCapture({ source_identity: "win32:1234abcd:0000000000009999" }),
  ]);
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "photos", canonical_path: ROOT }],
    rawCapture, idFactory: () => "localfile-" + "z".repeat(32),
  });
  const discovery = await adapter.findLocalFiles({ root_id: "photos", query: "", extensions: ["png"], max_results: 5 });
  await assert.rejects(() => adapter.statLocalFile(discovery.files[0].local_file_id), /local_file_source_changed/);
});

test("same-object A-B-A rewrite with restored mtime fails on private digest", async () => {
  const changed = Buffer.from(BYTES); changed[changed.length - 1] ^= 0xff;
  const changedDigest = "sha256:" + crypto.createHash("sha256").update(changed).digest("hex");
  const rawCapture = fakeCapture([
    normalizedCapture({ bytes: null }),
    normalizedCapture({ bytes: changed, content_digest: changedDigest }),
  ]);
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "photos", canonical_path: ROOT }],
    rawCapture, idFactory: () => "localfile-" + "q".repeat(32),
  });
  const discovery = await adapter.findLocalFiles({ root_id: "photos", query: "", extensions: ["png"], max_results: 5 });
  await assert.rejects(() => adapter.statLocalFile(discovery.files[0].local_file_id), /local_file_source_changed/);
});

test("stale and cross-adapter opaque IDs never resolve elsewhere", async () => {
  const first = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "photos", canonical_path: ROOT }],
    rawCapture: fakeCapture([normalizedCapture({ bytes: null })]),
    idFactory: () => "localfile-" + "a".repeat(32),
  });
  const second = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "other", canonical_path: ROOT }],
    rawCapture: fakeCapture([normalizedCapture({ bytes: null })]),
    idFactory: () => "localfile-" + "b".repeat(32),
  });
  const discovery = await first.findLocalFiles({ root_id: "photos", query: "", extensions: ["png"], max_results: 5 });
  assert.equal(second.getLocalFileImportBinding(discovery.files[0].local_file_id), null);
  await assert.rejects(() => second.statLocalFile(discovery.files[0].local_file_id), /local_file_source_invalid/);
});

test("raw bridge sanitizes capture failures", async () => {
  const sensitive = new Error("D:\\Private\\secret.png raw=89504e47 token=abc");
  const rawCapture = fakeCapture([normalizedCapture({ bytes: null }), sensitive]);
  const adapter = createRdcLocalFilesAdapter({
    rdc: makeDiscoveryRdc(), roots: [{ root_id: "photos", canonical_path: ROOT }],
    rawCapture, idFactory: () => "localfile-" + "c".repeat(32),
  });
  const discovery = await adapter.findLocalFiles({ root_id: "photos", query: "", extensions: ["png"], max_results: 5 });
  await assert.rejects(
    () => adapter.statLocalFile(discovery.files[0].local_file_id),
    (error) => {
      assert.equal(error.code, "local_file_source_failure");
      assert.equal(error.message, "local_file_source_failure");
      assert.doesNotMatch(JSON.stringify(error), /Private|secret|89504e47|abc/i);
      return true;
    },
  );
});


test("opaque local-file registry evicts oldest non-pending identity at configured capacity", async () => {
  const root = "D:\\RegistryRoot";
  const names = ["one.png", "two.png", "three.png"];
  let sequence = 0;
  const adapter = createRdcLocalFilesAdapter({
    rdc: {
      async findFiles({ query }) {
        const file = names.find((name) => name.startsWith(query));
        return [{
          canonical_path: root + "\\" + file,
          size_bytes: 1,
          modified_at: MODIFIED_AT,
          is_file: true,
          is_symlink: false,
          is_reparse_point: false,
        }];
      },
    },
    roots: [{ root_id: "root", canonical_path: root }],
    maxLiveFileIds: 2,
    idFactory: () => "localfile-" + String(++sequence).padStart(32, "0"),
  });

  const first = await adapter.findLocalFiles({ root_id: "root", query: "one", extensions: ["png"], max_results: 1 });
  const second = await adapter.findLocalFiles({ root_id: "root", query: "two", extensions: ["png"], max_results: 1 });
  assert.ok(adapter.resolveLocalFile(first.files[0].local_file_id));
  const third = await adapter.findLocalFiles({ root_id: "root", query: "three", extensions: ["png"], max_results: 1 });

  assert.equal(adapter.resolveLocalFile(second.files[0].local_file_id), null);
  assert.ok(adapter.resolveLocalFile(first.files[0].local_file_id));
  assert.ok(adapter.resolveLocalFile(third.files[0].local_file_id));
});

test("pending raw captures are bounded and abandoned pre-read state can recover", async () => {
  const root = "D:\\PendingRoot";
  const files = new Map([
    ["one.png", Buffer.from([1, 2, 3])],
    ["two.png", Buffer.from([4, 5, 6])],
  ]);
  const captures = new Map();
  for (const [name, bytes] of files) {
    captures.set(name, {
      canonical_path: root + "\\" + name,
      source_identity: "win32:1234abcd:" + (name === "one.png" ? "0000000000000001" : "0000000000000002"),
      size_bytes: bytes.length,
      modified_at: MODIFIED_AT,
      content_digest: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
      hard_link_count: 1,
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
      bytes,
    });
  }
  const rawCapture = {
    async captureFile({ canonical_path, include_bytes }) {
      const name = canonical_path.split("\\").at(-1);
      const value = captures.get(name);
      return {
        ...value,
        bytes: include_bytes ? Buffer.from(value.bytes) : null,
      };
    },
  };
  let sequence = 10;
  const adapter = createRdcLocalFilesAdapter({
    rdc: {
      async findFiles({ query }) {
        const name = query + ".png";
        const value = captures.get(name);
        return [{
          canonical_path: value.canonical_path,
          size_bytes: value.size_bytes,
          modified_at: value.modified_at,
          is_file: true,
          is_symlink: false,
          is_reparse_point: false,
        }];
      },
    },
    roots: [{ root_id: "root", canonical_path: root }],
    rawCapture,
    maxPendingCaptures: 1,
    idFactory: () => "localfile-" + String(++sequence).padStart(32, "0"),
  });

  const first = (await adapter.findLocalFiles({ root_id: "root", query: "one", extensions: ["png"], max_results: 1 })).files[0];
  const second = (await adapter.findLocalFiles({ root_id: "root", query: "two", extensions: ["png"], max_results: 1 })).files[0];

  await adapter.statLocalFile(first.local_file_id);
  await assert.rejects(() => adapter.statLocalFile(second.local_file_id), /local_file_capacity/);

  const recoveredBefore = await adapter.statLocalFile(first.local_file_id);
  assert.equal(recoveredBefore.source_identity, captures.get("one.png").source_identity);
  const bytes = await adapter.readLocalFile(first.local_file_id);
  assert.deepEqual(bytes, files.get("one.png"));
  const recoveredAfter = await adapter.statLocalFile(first.local_file_id);
  assert.deepEqual(recoveredAfter, recoveredBefore);

  const secondBefore = await adapter.statLocalFile(second.local_file_id);
  assert.equal(secondBefore.source_identity, captures.get("two.png").source_identity);
});
