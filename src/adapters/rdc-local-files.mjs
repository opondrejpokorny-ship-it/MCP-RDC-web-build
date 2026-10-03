import crypto from "node:crypto";
import { isSafeWindowsLocalSegment } from "../security/windows-local-path.mjs";

const ROOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTENSION_RE = /^[A-Za-z0-9]{1,16}$/;
const LOCAL_FILE_ID_RE = /^localfile-[A-Za-z0-9_-]{32,128}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_LIVE_FILE_IDS = 4096;
const DEFAULT_MAX_PENDING_CAPTURES = 2;
const MAX_SCAN_ENTRIES = 5000;

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function snapshotOwnDataFields(value, fields) {
  if (!isPlainObject(value)) return null;
  const snapshot = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor) return null;
    if (
      descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      throw safeError("local_file_source_failure");
    }
    snapshot[field] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function validRootId(value) {
  return typeof value === "string" && ROOT_ID_RE.test(value);
}

function validQuery(value) {
  return typeof value === "string"
    && value.length <= 128
    && !/[\\/\0\r\n\t]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && /^[\x20-\x7e]*$/.test(value);
}

function normalizeExtensions(value) {
  if (!Array.isArray(value) || value.length > 16) return null;
  const normalized = [];
  const seen = new Set();
  for (const extension of value) {
    if (typeof extension !== "string" || !EXTENSION_RE.test(extension)) return null;
    const folded = extension.toLowerCase();
    if (seen.has(folded)) return null;
    seen.add(folded);
    normalized.push(folded);
  }
  normalized.sort();
  return normalized;
}

function validDiscoveryRequest(request) {
  if (!exactKeys(request, ["root_id", "query", "extensions", "max_results"])) return false;
  if (!validRootId(request.root_id) || !validQuery(request.query)) return false;
  if (!normalizeExtensions(request.extensions)) return false;
  return Number.isInteger(request.max_results)
    && request.max_results >= 1
    && request.max_results <= 50;
}

function parseCanonicalWindowsPath(value, { allowDriveRoot = false } = {}) {
  if (typeof value !== "string" || value.length < 3 || value.length > 32767) return null;
  if (value.includes("/") || value.startsWith("\\")) {
    return null;
  }
  if (!/^[A-Za-z]:\\/.test(value)) return null;
  if (value.slice(2).includes(":")) return null;

  const drive = value.slice(0, 2);
  const tail = value.slice(3);
  if (tail === "") {
    return allowDriveRoot ? { drive, segments: [], canonical: drive + "\\" } : null;
  }
  if (value.endsWith("\\")) return null;
  const segments = tail.split("\\");
  if (!segments.every(isSafeWindowsLocalSegment)) return null;
  const canonical = drive + "\\" + segments.join("\\");
  return { drive, segments, canonical };
}

function foldedWindowsPath(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function strictRelativePath(rootPath, candidatePath) {
  const root = parseCanonicalWindowsPath(rootPath, { allowDriveRoot: true });
  const candidate = parseCanonicalWindowsPath(candidatePath);
  if (!root || !candidate) return null;
  if (root.drive.toLowerCase() !== candidate.drive.toLowerCase()) return null;

  const rootFolded = foldedWindowsPath(root.canonical);
  const candidateFolded = foldedWindowsPath(candidate.canonical);
  const prefix = root.segments.length === 0
    ? rootFolded
    : rootFolded + "\\";
  if (!candidateFolded.startsWith(prefix)) return null;
  if (candidateFolded === rootFolded) return null;

  const relative = candidate.canonical.slice(prefix.length);
  if (!relative) return null;
  const segments = relative.split("\\");
  if (!segments.length || !segments.every(isSafeWindowsLocalSegment)) return null;
  return segments.join("/");
}

function strictIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function extensionOfRelativePath(relativePath) {
  const basename = relativePath.split("/").at(-1);
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === basename.length - 1) return "";
  return basename.slice(lastDot + 1).toLowerCase();
}

function basenameMatchesQuery(relativePath, query) {
  if (query === "") return true;
  const basename = relativePath.split("/").at(-1);
  return basename.toLowerCase().includes(query.toLowerCase());
}function defaultIdFactory() {
  return "localfile-" + crypto.randomBytes(24).toString("base64url");
}

function requireRdc(rdc) {
  if (!rdc || typeof rdc.findFiles !== "function") {
    throw new TypeError("rdc_findFiles_required");
  }
}

function requireRawCapture(rawCapture) {
  if (rawCapture !== null && (!isPlainObject(rawCapture) || typeof rawCapture.captureFile !== "function")) {
    throw new TypeError("local_file_raw_capture_invalid");
  }
}

function trustedCaptureSnapshot(raw, { includeBytes }) {
  try {
    const source = snapshotOwnDataFields(raw, [
      "canonical_path",
      "source_identity",
      "size_bytes",
      "modified_at",
      "content_digest",
      "hard_link_count",
      "is_file",
      "is_symlink",
      "is_reparse_point",
      "bytes",
    ]);
    if (
      !source
      || typeof source.canonical_path !== "string"
      || typeof source.source_identity !== "string"
      || source.source_identity.length < 1
      || source.source_identity.length > 8192
      || !Number.isSafeInteger(source.size_bytes)
      || source.size_bytes < 0
      || !strictIsoUtc(source.modified_at)
      || typeof source.content_digest !== "string"
      || !DIGEST_RE.test(source.content_digest)
      || source.hard_link_count !== 1
      || source.is_file !== true
      || source.is_symlink !== false
      || source.is_reparse_point !== false
      || (includeBytes
        ? (!Buffer.isBuffer(source.bytes) && !(source.bytes instanceof Uint8Array))
        : source.bytes !== null)
    ) {
      throw safeError("local_file_source_invalid");
    }
    return Object.freeze({
      ...source,
      bytes: includeBytes ? Buffer.from(source.bytes) : null,
    });
  } catch (error) {
    if (error?.code === "local_file_source_invalid") throw error;
    throw safeError("local_file_source_failure");
  }
}

function snapshotRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 64) {
    throw new TypeError("local_file_root_invalid");
  }

  const byId = new Map();
  const foldedIds = new Set();
  for (const entry of roots) {
    if (
      !exactKeys(entry, ["root_id", "canonical_path"])
      || !validRootId(entry.root_id)
    ) {
      throw new TypeError("local_file_root_invalid");
    }
    const parsed = parseCanonicalWindowsPath(entry.canonical_path, { allowDriveRoot: true });
    if (!parsed || parsed.canonical !== entry.canonical_path) {
      throw new TypeError("local_file_root_invalid");
    }
    const foldedId = entry.root_id.toLowerCase();
    if (foldedIds.has(foldedId)) throw new TypeError("local_file_root_invalid");
    foldedIds.add(foldedId);
    byId.set(entry.root_id, Object.freeze({
      root_id: entry.root_id,
      canonical_path: entry.canonical_path,
    }));
  }
  return byId;
}

export function createRdcLocalFilesAdapter({
  rdc,
  roots,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxLiveFileIds = DEFAULT_MAX_LIVE_FILE_IDS,
  maxPendingCaptures = DEFAULT_MAX_PENDING_CAPTURES,
  idFactory = defaultIdFactory,
  rawCapture = null,
}) {
  requireRdc(rdc);
  requireRawCapture(rawCapture);
  const rootsById = snapshotRoots(roots);
  if (
    !Number.isSafeInteger(maxFileBytes)
    || maxFileBytes < 1
    || maxFileBytes > 1024 * 1024 * 1024
  ) {
    throw new TypeError("local_file_limit_invalid");
  }
  if (
    !Number.isSafeInteger(maxLiveFileIds)
    || maxLiveFileIds < 1
    || maxLiveFileIds > 65536
  ) {
    throw new TypeError("local_file_id_capacity_invalid");
  }
  if (
    !Number.isSafeInteger(maxPendingCaptures)
    || maxPendingCaptures < 1
    || maxPendingCaptures > 32
  ) {
    throw new TypeError("local_file_capture_capacity_invalid");
  }
  if (typeof idFactory !== "function") throw new TypeError("local_file_id_factory_invalid");

  const identityToId = new Map();
  const idToIdentity = new Map();
  const pendingCaptures = new Map();

  function touchIdentity(localFileId, identity) {
    if (!identity) return null;
    idToIdentity.delete(localFileId);
    idToIdentity.set(localFileId, identity);
    return identity;
  }

  function evictOldestIdentity() {
    for (const [localFileId, identity] of idToIdentity) {
      if (pendingCaptures.has(localFileId)) continue;
      idToIdentity.delete(localFileId);
      identityToId.delete(identity.identity_key);
      return true;
    }
    return false;
  }

  function allocateId(identity) {
    const existing = identityToId.get(identity.identity_key);
    if (existing) {
      touchIdentity(existing, idToIdentity.get(existing));
      return existing;
    }

    while (idToIdentity.size >= maxLiveFileIds) {
      if (!evictOldestIdentity()) throw safeError("local_file_capacity");
    }

    const candidate = idFactory();
    if (typeof candidate !== "string" || !LOCAL_FILE_ID_RE.test(candidate)) {
      throw safeError("local_file_id_invalid");
    }
    const priorIdentity = idToIdentity.get(candidate);
    if (priorIdentity && priorIdentity.identity_key !== identity.identity_key) {
      throw safeError("local_file_id_collision");
    }

    identityToId.set(identity.identity_key, candidate);
    idToIdentity.set(candidate, Object.freeze(identity));
    return candidate;
  }

  function resolveIdentity(localFileId) {
    if (typeof localFileId !== "string" || !LOCAL_FILE_ID_RE.test(localFileId)) return null;
    const identity = idToIdentity.get(localFileId) ?? null;
    return identity ? touchIdentity(localFileId, identity) : null;
  }

  function resolveLocalFile(localFileId) {
    const identity = resolveIdentity(localFileId);
    return identity ? structuredClone(identity) : null;
  }

  function getLocalFileImportBinding(localFileId) {
    const identity = resolveIdentity(localFileId);
    if (
      !identity
      || typeof identity.content_digest !== "string"
      || !DIGEST_RE.test(identity.content_digest)
    ) return null;
    return Object.freeze({
      size_bytes: identity.size_bytes,
      modified_at: identity.modified_at,
      content_digest: identity.content_digest,
    });
  }

  async function captureForIdentity(identity, includeBytes) {
    if (!rawCapture) throw safeError("local_file_source_failure");
    const root = rootsById.get(identity.root_id);
    if (!root) throw safeError("local_file_source_invalid");
    let raw;
    try {
      raw = await rawCapture.captureFile({
        canonical_path: identity.canonical_path,
        root_path: root.canonical_path,
        include_bytes: includeBytes,
      });
    } catch (error) {
      if (
        error?.code === "local_file_source_invalid"
        || error?.code === "local_file_source_changed"
      ) throw error;
      throw safeError("local_file_source_failure");
    }
    const capture = trustedCaptureSnapshot(raw, { includeBytes });
    if (
      foldedWindowsPath(capture.canonical_path) !== foldedWindowsPath(identity.canonical_path)
      || capture.size_bytes > maxFileBytes
    ) {
      throw safeError("local_file_source_invalid");
    }
    if (includeBytes) {
      const bytes = Buffer.from(capture.bytes);
      const digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== capture.size_bytes || digest !== capture.content_digest) {
        throw safeError("local_file_source_invalid");
      }
    }
    return capture;
  }

  function metadataFromCapture(identity, capture) {
    return Object.freeze({
      source_identity: capture.source_identity,
      relative_path: identity.relative_path,
      size_bytes: capture.size_bytes,
      modified_at: capture.modified_at,
      extension: identity.extension,
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
    });
  }

  function captureWithoutBytes(capture) {
    return Object.freeze({
      canonical_path: capture.canonical_path,
      source_identity: capture.source_identity,
      size_bytes: capture.size_bytes,
      modified_at: capture.modified_at,
      content_digest: capture.content_digest,
      hard_link_count: capture.hard_link_count,
      is_file: capture.is_file,
      is_symlink: capture.is_symlink,
      is_reparse_point: capture.is_reparse_point,
      bytes: null,
    });
  }

  async function statLocalFile(localFileId) {
    if (!rawCapture) throw safeError("local_file_source_failure");
    const identity = resolveIdentity(localFileId);
    if (
      !identity
      || typeof identity.source_identity !== "string"
      || typeof identity.content_digest !== "string"
    ) {
      throw safeError("local_file_source_invalid");
    }

    const pending = pendingCaptures.get(localFileId);
    if (pending) {
      if (pending.stage === "after_read") {
        pendingCaptures.delete(localFileId);
        return metadataFromCapture(identity, pending.capture);
      }
      pendingCaptures.delete(localFileId);
    }

    const capture = await captureForIdentity(identity, true);
    if (
      capture.size_bytes !== identity.size_bytes
      || capture.modified_at !== identity.modified_at
    ) {
      return metadataFromCapture(identity, capture);
    }
    if (
      capture.source_identity !== identity.source_identity
      || capture.content_digest !== identity.content_digest
    ) {
      throw safeError("local_file_source_changed");
    }

    if (pendingCaptures.size >= maxPendingCaptures) {
      throw safeError("local_file_capacity");
    }
    pendingCaptures.set(localFileId, {
      stage: "awaiting_read",
      capture,
    });
    return metadataFromCapture(identity, capture);
  }

  async function readLocalFile(localFileId) {
    if (!rawCapture) throw safeError("local_file_source_failure");
    const pending = pendingCaptures.get(localFileId);
    if (!pending || pending.stage !== "awaiting_read") {
      throw safeError("local_file_source_invalid");
    }
    const bytes = Buffer.from(pending.capture.bytes);
    pending.stage = "after_read";
    pending.capture = captureWithoutBytes(pending.capture);
    return bytes;
  }

  async function findLocalFiles(request) {
    if (!validDiscoveryRequest(request)) throw safeError("local_file_request_invalid");
    const root = rootsById.get(request.root_id);
    if (!root) throw safeError("local_file_root_unavailable");

    const extensions = normalizeExtensions(request.extensions);
    let entries;
    try {
      entries = await rdc.findFiles({
        root_path: root.canonical_path,
        query: request.query,
        extensions: [...extensions],
        max_results: request.max_results,
        max_scan_entries: MAX_SCAN_ENTRIES,
      });
    } catch {
      throw safeError("local_file_source_failure");
    }

    let staged;
    try {
      if (!Array.isArray(entries) || entries.length > request.max_results || entries.length > MAX_SCAN_ENTRIES) {
        throw safeError("local_file_source_invalid");
      }

      staged = [];
      const stagedKeys = new Set();
      for (const entry of entries) {
        const source = snapshotOwnDataFields(entry, [
          "canonical_path",
          "size_bytes",
          "modified_at",
          "is_file",
          "is_symlink",
          "is_reparse_point",
        ]);
        if (
          !source
          || source.is_file !== true
          || source.is_symlink !== false
          || source.is_reparse_point !== false
          || !Number.isSafeInteger(source.size_bytes)
          || source.size_bytes < 0
          || source.size_bytes > maxFileBytes
          || !strictIsoUtc(source.modified_at)
        ) {
          throw safeError("local_file_source_invalid");
        }

        const relativePath = strictRelativePath(root.canonical_path, source.canonical_path);
        if (!relativePath) throw safeError("local_file_source_invalid");
        const extension = extensionOfRelativePath(relativePath);
        if (extensions.length > 0 && !extensions.includes(extension)) {
          throw safeError("local_file_source_invalid");
        }
        if (!basenameMatchesQuery(relativePath, request.query)) {
          throw safeError("local_file_source_invalid");
        }

        let trusted = null;
        if (rawCapture) {
          const provisionalIdentity = {
            root_id: request.root_id,
            canonical_path: source.canonical_path,
          };
          trusted = await captureForIdentity(provisionalIdentity, false);
          if (
            trusted.size_bytes !== source.size_bytes
            || trusted.modified_at !== source.modified_at
          ) {
            throw safeError("local_file_source_invalid");
          }
        }

        const identityKey = request.root_id.toLowerCase()
          + "\0"
          + foldedWindowsPath(source.canonical_path)
          + (trusted
            ? "\0" + trusted.source_identity
              + "\0" + trusted.content_digest
              + "\0" + trusted.size_bytes
              + "\0" + trusted.modified_at
            : "");
        if (stagedKeys.has(identityKey)) continue;
        stagedKeys.add(identityKey);

        staged.push({
          identity_key: identityKey,
          root_id: request.root_id,
          canonical_path: source.canonical_path,
          relative_path: relativePath,
          size_bytes: source.size_bytes,
          extension,
          modified_at: source.modified_at,
          source_identity: trusted?.source_identity ?? null,
          content_digest: trusted?.content_digest ?? null,
        });
      }

      staged.sort((a, b) =>
        a.relative_path.localeCompare(b.relative_path, "en", { sensitivity: "base" })
        || a.relative_path.localeCompare(b.relative_path, "en", { sensitivity: "variant" })
      );
    } catch (error) {
      if (error?.code === "local_file_source_invalid") throw error;
      throw safeError("local_file_source_failure");
    }

    const newlyAllocated = [];
    try {
      const files = staged.map((identity) => {
        const hadId = identityToId.has(identity.identity_key);
        const local_file_id = allocateId(identity);
        if (!hadId) newlyAllocated.push({ identityKey: identity.identity_key, localFileId: local_file_id });
        return Object.freeze({
          local_file_id,
          relative_path: identity.relative_path,
          size_bytes: identity.size_bytes,
          extension: identity.extension,
          modified_at: identity.modified_at,
        });
      });
      return Object.freeze({
        root_id: request.root_id,
        files: Object.freeze(files),
      });
    } catch (error) {
      for (const allocation of newlyAllocated) {
        identityToId.delete(allocation.identityKey);
        idToIdentity.delete(allocation.localFileId);
      }
      if (error?.code === "local_file_id_collision" || error?.code === "local_file_id_invalid") {
        throw error;
      }
      throw safeError("local_file_source_invalid");
    }
  }

  if (rawCapture) {
    return Object.freeze({
      findLocalFiles,
      resolveLocalFile,
      getLocalFileImportBinding,
      statLocalFile,
      readLocalFile,
    });
  }
  return Object.freeze({
    findLocalFiles,
    resolveLocalFile,
  });
}