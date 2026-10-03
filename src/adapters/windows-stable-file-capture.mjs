import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSafeWindowsLocalSegment } from "../security/windows-local-path.mjs";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SOURCE_ID_RE = /^win32:[a-f0-9]{8}:[a-f0-9]{16}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_STDERR = 32 * 1024;
const HELPER_PATH = fileURLToPath(new URL("./windows-stable-file-capture.ps1", import.meta.url));

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
  const out = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw safeError("local_file_source_failure");
    }
    out[field] = descriptor.value;
  }
  return Object.freeze(out);
}

function parseCanonicalWindowsPath(value, { allowDriveRoot = false } = {}) {
  if (typeof value !== "string" || value.length < 3 || value.length > 32767) return null;
  if (value.includes("/") || value.startsWith("\\")) return null;
  if (!/^[A-Za-z]:\\/.test(value) || value.slice(2).includes(":")) return null;
  const drive = value.slice(0, 2);
  const tail = value.slice(3);
  if (tail === "") {
    return allowDriveRoot ? { drive, segments: [], canonical: drive + "\\" } : null;
  }
  if (value.endsWith("\\")) return null;
  const segments = tail.split("\\");
  if (!segments.every(isSafeWindowsLocalSegment)) return null;
  return { drive, segments, canonical: drive + "\\" + segments.join("\\") };
}

function folded(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function strictRelativePath(rootPath, candidatePath) {
  const root = parseCanonicalWindowsPath(rootPath, { allowDriveRoot: true });
  const candidate = parseCanonicalWindowsPath(candidatePath);
  if (!root || !candidate || root.drive.toLowerCase() !== candidate.drive.toLowerCase()) return null;
  const rootFolded = folded(root.canonical);
  const candidateFolded = folded(candidate.canonical);
  const prefix = root.segments.length === 0 ? rootFolded : rootFolded + "\\";
  if (!candidateFolded.startsWith(prefix) || candidateFolded === rootFolded) return null;
  const relative = candidate.canonical.slice(prefix.length);
  if (!relative) return null;
  const segments = relative.split("\\");
  return segments.length > 0 && segments.every(isSafeWindowsLocalSegment)
    ? segments.join("/")
    : null;
}

function strictIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(bytes) {
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalBase64(value) {
  if (typeof value !== "string") return null;
  if (value === "") return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function minimalPowerShellEnvironment() {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function defaultPowerShellRunner({
  powershellPath,
  timeoutMs,
}) {
  return (request) => new Promise((resolve, reject) => {
    const maxStdout = request.include_bytes
      ? 4 * Math.ceil(request.max_bytes / 3) + 128 * 1024
      : 128 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let settled = false;

    const child = spawn(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        HELPER_PATH,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: minimalPowerShellEnvironment(),
      },
    );

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, safeError("local_file_source_failure"));
    }, timeoutMs);
    timer.unref?.();

    child.once("error", () => finish(reject, safeError("local_file_source_failure")));

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        try { child.kill(); } catch {}
        finish(reject, safeError("local_file_source_invalid"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROVIDER_STDERR) {
        try { child.kill(); } catch {}
        finish(reject, safeError("local_file_source_failure"));
      }
    });

    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(reject, safeError("local_file_source_failure"));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        finish(reject, safeError("local_file_source_failure"));
        return;
      }
      try {
        const raw = snapshotOwnDataFields(parsed, [
          "canonical_path",
          "source_identity",
          "size_bytes",
          "modified_at",
          "content_digest",
          "hard_link_count",
          "is_file",
          "is_symlink",
          "is_reparse_point",
          "bytes_base64",
        ]);
        if (!raw || !exactKeys(parsed, Object.keys(raw))) throw safeError("local_file_source_invalid");
        const bytes = request.include_bytes ? canonicalBase64(raw.bytes_base64) : null;
        if (
          (request.include_bytes && !bytes)
          || (!request.include_bytes && raw.bytes_base64 !== null)
        ) {
          throw safeError("local_file_source_invalid");
        }
        finish(resolve, Object.freeze({
          canonical_path: raw.canonical_path,
          source_identity: raw.source_identity,
          size_bytes: raw.size_bytes,
          modified_at: raw.modified_at,
          content_digest: raw.content_digest,
          hard_link_count: raw.hard_link_count,
          is_file: raw.is_file,
          is_symlink: raw.is_symlink,
          is_reparse_point: raw.is_reparse_point,
          bytes,
        }));
      } catch (error) {
        finish(reject, error?.code === "local_file_source_invalid"
          ? error
          : safeError("local_file_source_failure"));
      }
    });

    try {
      child.stdin.end(JSON.stringify(request));
    } catch {
      try { child.kill(); } catch {}
      finish(reject, safeError("local_file_source_failure"));
    }
  });
}

function normalizeCapture(raw, { canonicalPath, maxFileBytes, includeBytes }) {
  let source;
  try {
    source = snapshotOwnDataFields(raw, [
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
  } catch (error) {
    if (error?.code === "local_file_source_failure") throw error;
    throw safeError("local_file_source_failure");
  }
  if (
    !source
    || !exactKeys(raw, Object.keys(source))
    || typeof source.canonical_path !== "string"
    || folded(source.canonical_path) !== folded(canonicalPath)
    || typeof source.source_identity !== "string"
    || !SOURCE_ID_RE.test(source.source_identity)
    || !Number.isSafeInteger(source.size_bytes)
    || source.size_bytes < 0
    || source.size_bytes > maxFileBytes
    || !strictIsoUtc(source.modified_at)
    || typeof source.content_digest !== "string"
    || !DIGEST_RE.test(source.content_digest)
    || source.hard_link_count !== 1
    || source.is_file !== true
    || source.is_symlink !== false
    || source.is_reparse_point !== false
  ) {
    throw safeError("local_file_source_invalid");
  }

  if (includeBytes) {
    if (!Buffer.isBuffer(source.bytes) && !(source.bytes instanceof Uint8Array)) {
      throw safeError("local_file_source_invalid");
    }
    const bytes = Buffer.from(source.bytes);
    if (bytes.length !== source.size_bytes || sha256(bytes) !== source.content_digest) {
      throw safeError("local_file_source_invalid");
    }
    return Object.freeze({
      canonical_path: canonicalPath,
      source_identity: source.source_identity,
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
      content_digest: source.content_digest,
      hard_link_count: 1,
      is_file: true,
      is_symlink: false,
      is_reparse_point: false,
      bytes,
    });
  }

  if (source.bytes !== null) throw safeError("local_file_source_invalid");
  return Object.freeze({
    canonical_path: canonicalPath,
    source_identity: source.source_identity,
    size_bytes: source.size_bytes,
    modified_at: source.modified_at,
    content_digest: source.content_digest,
    hard_link_count: 1,
    is_file: true,
    is_symlink: false,
    is_reparse_point: false,
    bytes: null,
  });
}

export function createWindowsStableFileCapture({
  validatePath,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  runCapture = null,
  powershellPath = "powershell.exe",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  helperHoldOpenMs = 0,
} = {}) {
  if (typeof validatePath !== "function") throw new TypeError("local_file_validate_path_required");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 1024 * 1024 * 1024) {
    throw new TypeError("local_file_limit_invalid");
  }
  if (runCapture !== null && typeof runCapture !== "function") {
    throw new TypeError("local_file_capture_runner_invalid");
  }
  if (typeof powershellPath !== "string" || powershellPath.length < 1 || powershellPath.length > 1024) {
    throw new TypeError("local_file_powershell_invalid");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new TypeError("local_file_capture_timeout_invalid");
  }
  if (!Number.isInteger(helperHoldOpenMs) || helperHoldOpenMs < 0 || helperHoldOpenMs > 5000) {
    throw new TypeError("local_file_capture_hold_invalid");
  }

  const runner = runCapture ?? defaultPowerShellRunner({ powershellPath, timeoutMs });

  async function captureFile(request) {
    if (!exactKeys(request, ["canonical_path", "root_path", "include_bytes"])) {
      throw safeError("local_file_source_invalid");
    }
    const root = parseCanonicalWindowsPath(request.root_path, { allowDriveRoot: true });
    const candidate = parseCanonicalWindowsPath(request.canonical_path);
    if (!root || !candidate || !strictRelativePath(root.canonical, candidate.canonical)) {
      throw safeError("local_file_source_invalid");
    }
    if (typeof request.include_bytes !== "boolean") throw safeError("local_file_source_invalid");

    let validated;
    try {
      validated = await validatePath(candidate.canonical);
    } catch {
      throw safeError("local_file_source_failure");
    }
    const validatedPath = parseCanonicalWindowsPath(validated);
    if (
      !validatedPath
      || folded(validatedPath.canonical) !== folded(candidate.canonical)
      || !strictRelativePath(root.canonical, validatedPath.canonical)
    ) {
      throw safeError("local_file_source_invalid");
    }

    let raw;
    try {
      raw = await runner(Object.freeze({
        canonical_path: validatedPath.canonical,
        max_bytes: maxFileBytes,
        include_bytes: request.include_bytes,
        hold_open_ms: helperHoldOpenMs,
      }));
    } catch (error) {
      if (error?.code === "local_file_source_invalid") throw error;
      throw safeError("local_file_source_failure");
    }
    return normalizeCapture(raw, {
      canonicalPath: validatedPath.canonical,
      maxFileBytes,
      includeBytes: request.include_bytes,
    });
  }

  return Object.freeze({ captureFile });
}
