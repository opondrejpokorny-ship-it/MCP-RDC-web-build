import crypto from "node:crypto";
import { WEBSITE_TOOL_NAMES } from "../contracts/tool-names.mjs";
import { hasMutationEnvelopeShape } from "../contracts/request-envelope.mjs";
import {
  isSafeWindowsLocalSegment,
  isSafeWindowsRelativePath,
} from "../security/windows-local-path.mjs";

export const EXECUTABLE_WEBSITE_TOOL_NAMES = Object.freeze([
  "website_project_status",
  "website_project_inspect",
  "website_change_prepare",
  "website_change_apply",
  "website_build_check",
  "website_change_reject",
  "website_change_accept",
  "website_preview_get",
  "website_local_files_find",
  "website_asset_import",
]);

const EXECUTABLE_SET = new Set(EXECUTABLE_WEBSITE_TOOL_NAMES);
const DECLARED_SET = new Set(WEBSITE_TOOL_NAMES);
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OPERATION_REVISION_RE = /^[1-9][0-9]{0,19}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCAL_FILE_ID_RE = /^localfile-[A-Za-z0-9_-]{32,128}$/;
const ASSET_ID_RE = /^asset-[A-Za-z0-9_-]{32,128}$/;
const PREPARED_CHANGE_ID_RE = /^change-[A-Za-z0-9_-]{32,128}$/;
const APPROVAL_REF_RE = /^approvalref-[A-Za-z0-9_-]{32,128}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_ASSET_IMPORT_BYTES = 1024 * 1024 * 1024;
const MAX_CHANGE_OPERATIONS = 64;
const MAX_CHANGE_PLAN_BYTES = 1024 * 1024;
const ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
const EXTENSION_RE = /^[A-Za-z0-9]{1,16}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEVERITIES = new Set(["error", "warning", "info"]);
const WORKFLOW_STATES = new Set([
  "working",
  "change_active",
  "review_required",
  "accepted",
  "release_ready",
  "release_active",
]);

function fail(error_code) {
  return Object.freeze({ ok: false, error_code });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, requiredKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...requiredKeys].sort();
  return keys.length === required.length
    && keys.every((key, index) => key === required[index]);
}

function snapshotOwnDataFields(value, fields) {
  if (!isPlainObject(value)) return null;
  const snapshot = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    snapshot[field] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function validProjectId(value) {
  if (typeof value !== "string" || !PROJECT_RE.test(value) || value === "." || value === "..") return false;
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

function validOperationId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function validOperationRevision(value) {
  return typeof value === "string" && OPERATION_REVISION_RE.test(value);
}

function validDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function validWorkspacePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return !segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "));
}

function validateStatusRequest(args) {
  return exactKeys(args, ["project_id"]) && validProjectId(args.project_id);
}

function validateDigestBoundRequest(args) {
  return exactKeys(args, ["project_id", "expected_workspace_digest"])
    && validProjectId(args.project_id)
    && validDigest(args.expected_workspace_digest);
}

function validateOperationBoundRequest(args) {
  return exactKeys(args, [
    "project_id",
    "operation_id",
    "operation_revision",
    "expected_workspace_digest",
  ])
    && validProjectId(args.project_id)
    && validOperationId(args.operation_id)
    && validOperationRevision(args.operation_revision)
    && validDigest(args.expected_workspace_digest);
}

function snapshotChangeOperations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHANGE_OPERATIONS) return null;
  const operations = [];
  let totalBytes = 0;
  for (const operation of value) {
    if (!isPlainObject(operation)) return null;
    const typeDescriptor = Object.getOwnPropertyDescriptor(operation, "type");
    if (
      !typeDescriptor
      || typeDescriptor.enumerable !== true
      || !Object.hasOwn(typeDescriptor, "value")
    ) return null;
    const type = typeDescriptor.value;
    if (type === "write") {
      if (!exactKeys(operation, ["type", "path", "content"])) return null;
      const snapshot = snapshotOwnDataFields(operation, ["type", "path", "content"]);
      if (
        !snapshot
        || snapshot.type !== "write"
        || !validWorkspacePath(snapshot.path)
        || typeof snapshot.content !== "string"
      ) return null;
      totalBytes += Buffer.byteLength(snapshot.path, "utf8")
        + Buffer.byteLength(snapshot.content, "utf8");
      if (totalBytes > MAX_CHANGE_PLAN_BYTES) return null;
      operations.push(Object.freeze({
        type: "write",
        path: snapshot.path,
        content: snapshot.content,
      }));
      continue;
    }
    if (type === "delete") {
      if (!exactKeys(operation, ["type", "path"])) return null;
      const snapshot = snapshotOwnDataFields(operation, ["type", "path"]);
      if (!snapshot || snapshot.type !== "delete" || !validWorkspacePath(snapshot.path)) return null;
      totalBytes += Buffer.byteLength(snapshot.path, "utf8");
      if (totalBytes > MAX_CHANGE_PLAN_BYTES) return null;
      operations.push(Object.freeze({
        type: "delete",
        path: snapshot.path,
      }));
      continue;
    }
    return null;
  }
  return Object.freeze(operations);
}

function validateChangePrepareRequest(args) {
  if (!exactKeys(args, ["project_id", "expected_workspace_digest", "operations"])) return false;
  const snapshot = snapshotOwnDataFields(args, [
    "project_id",
    "expected_workspace_digest",
    "operations",
  ]);
  return !!snapshot
    && validProjectId(snapshot.project_id)
    && validDigest(snapshot.expected_workspace_digest)
    && snapshotChangeOperations(snapshot.operations) !== null;
}

function validateChangeApplyRequest(args) {
  if (!exactKeys(args, ["project_id", "prepared_change_id"])) return false;
  const snapshot = snapshotOwnDataFields(args, ["project_id", "prepared_change_id"]);
  return !!snapshot
    && validProjectId(snapshot.project_id)
    && typeof snapshot.prepared_change_id === "string"
    && PREPARED_CHANGE_ID_RE.test(snapshot.prepared_change_id);
}

function validateReviewDecisionRequest(args) {
  if (!exactKeys(args, [
    "project_id",
    "operation_id",
    "operation_revision",
    "expected_workspace_digest",
    "approval_id",
  ])) return false;
  const snapshot = snapshotOwnDataFields(args, [
    "project_id",
    "operation_id",
    "operation_revision",
    "expected_workspace_digest",
    "approval_id",
  ]);
  return !!snapshot
    && validProjectId(snapshot.project_id)
    && validOperationId(snapshot.operation_id)
    && validOperationRevision(snapshot.operation_revision)
    && validDigest(snapshot.expected_workspace_digest)
    && typeof snapshot.approval_id === "string"
    && APPROVAL_REF_RE.test(snapshot.approval_id);
}
function validateLocalFilesRequest(args) {
  if (!exactKeys(args, ["root_id", "query", "extensions", "max_results"])) return false;
  if (typeof args.root_id !== "string" || !ROOT_ID_RE.test(args.root_id)) return false;
  if (
    typeof args.query !== "string"
    || args.query.length > 128
    || /[\\/\0\r\n\t]/.test(args.query)
    || /[\u0000-\u001f\u007f]/.test(args.query)
    || !/^[\x20-\x7e]*$/.test(args.query)
  ) return false;
  if (!Array.isArray(args.extensions) || args.extensions.length > 16) return false;
  const seen = new Set();
  for (const extension of args.extensions) {
    if (typeof extension !== "string" || !EXTENSION_RE.test(extension)) return false;
    const folded = extension.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
  }
  return Number.isInteger(args.max_results)
    && args.max_results >= 1
    && args.max_results <= 50;
}

function validateAssetImportRequest(args) {
  return exactKeys(args, [
    "project_id",
    "local_file_id",
    "size_bytes",
    "modified_at",
  ])
    && validProjectId(args.project_id)
    && typeof args.local_file_id === "string"
    && LOCAL_FILE_ID_RE.test(args.local_file_id)
    && Number.isSafeInteger(args.size_bytes)
    && args.size_bytes >= 0
    && args.size_bytes <= MAX_ASSET_IMPORT_BYTES
    && strictIsoUtc(args.modified_at);
}

function assetImportIdempotencyKey(args) {
  const canonical = JSON.stringify({
    project_id: args.project_id,
    local_file_id: args.local_file_id,
    size_bytes: args.size_bytes,
    modified_at: args.modified_at,
  });
  return "website-asset-import:"
    + crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalChangePrepareRequest(args) {
  const operations = snapshotChangeOperations(args.operations);
  if (!operations) return null;
  return Object.freeze({
    project_id: args.project_id,
    expected_workspace_digest: args.expected_workspace_digest,
    operations,
  });
}

function changePrepareIdempotencyKey(args) {
  const canonical = canonicalChangePrepareRequest(args);
  if (!canonical) return null;
  return "website-change-prepare:"
    + crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function reviewDecisionIdempotencyKey(toolName, args) {
  const canonical = JSON.stringify({
    tool_name: toolName,
    approval_id: args.approval_id,
    project_id: args.project_id,
    operation_id: args.operation_id,
    operation_revision: args.operation_revision,
    expected_workspace_digest: args.expected_workspace_digest,
  });
  return toolName.replaceAll("_", "-") + ":"
    + crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
function trustedAssetImportBinding(raw, args) {
  const binding = snapshotOwnDataFields(raw, [
    "size_bytes",
    "modified_at",
    "content_digest",
  ]);
  if (
    !binding
    || !exactKeys(raw, ["size_bytes", "modified_at", "content_digest"])
    || !Number.isSafeInteger(binding.size_bytes)
    || binding.size_bytes < 0
    || binding.size_bytes > MAX_ASSET_IMPORT_BYTES
    || !strictIsoUtc(binding.modified_at)
    || typeof binding.content_digest !== "string"
    || !SHA256_RE.test(binding.content_digest)
  ) return null;
  if (
    binding.size_bytes !== args.size_bytes
    || binding.modified_at !== args.modified_at
  ) return false;
  return binding;
}

function expectedSourceHandleDigest(localFileId) {
  return "sha256:"
    + crypto.createHash("sha256")
      .update("local_file_id:" + localFileId, "utf8")
      .digest("hex");
}

const PROJECT_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});

const OPERATION_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
});

const OPERATION_REVISION_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$",
});

const DIGEST_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^[a-f0-9]{64}$",
});

const ROOT_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
});

const QUERY_SCHEMA = Object.freeze({
  type: "string",
  maxLength: 128,
  pattern: "^[^\\\\/\\u0000-\\u001f\\u007f]*$",
});

const EXTENSIONS_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 16,
  uniqueItems: true,
  items: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: 16,
    pattern: "^[A-Za-z0-9]{1,16}$",
  }),
});

const MAX_RESULTS_SCHEMA = Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: 50,
});

const LOCAL_FILE_ID_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^localfile-[A-Za-z0-9_-]{32,128}$",
});

const ASSET_SIZE_SCHEMA = Object.freeze({
  type: "integer",
  minimum: 0,
  maximum: MAX_ASSET_IMPORT_BYTES,
});

const MODIFIED_AT_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});

function closedSchema(properties, required) {
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze([...required]),
    additionalProperties: false,
  });
}

const PREPARED_CHANGE_ID_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^change-[A-Za-z0-9_-]{32,128}$",
});

const APPROVAL_REF_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^approvalref-[A-Za-z0-9_-]{32,128}$",
});

const CHANGE_PATH_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 1024,
});

const CHANGE_OPERATION_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    closedSchema(
      {
        type: Object.freeze({ const: "write" }),
        path: CHANGE_PATH_SCHEMA,
        content: Object.freeze({
          type: "string",
          maxLength: MAX_CHANGE_PLAN_BYTES,
        }),
      },
      ["type", "path", "content"],
    ),
    closedSchema(
      {
        type: Object.freeze({ const: "delete" }),
        path: CHANGE_PATH_SCHEMA,
      },
      ["type", "path"],
    ),
  ]),
});

const CHANGE_OPERATIONS_SCHEMA = Object.freeze({
  type: "array",
  minItems: 1,
  maxItems: MAX_CHANGE_OPERATIONS,
  items: CHANGE_OPERATION_SCHEMA,
});
const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "website_project_status",
    description: "Return bounded authoritative static_web project lifecycle state.",
    inputSchema: closedSchema(
      { project_id: PROJECT_ID_SCHEMA },
      ["project_id"],
    ),
  }),
  Object.freeze({
    name: "website_project_inspect",
    description: "Return bounded workspace metadata for an exact authoritative digest.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        expected_workspace_digest: DIGEST_SCHEMA,
      },
      ["project_id", "expected_workspace_digest"],
    ),
  }),
  Object.freeze({
    name: "website_change_prepare",
    description: "Prepare an exact bounded static_web change transaction without mutating the workspace.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        expected_workspace_digest: DIGEST_SCHEMA,
        operations: CHANGE_OPERATIONS_SCHEMA,
      },
      ["project_id", "expected_workspace_digest", "operations"],
    ),
  }),
  Object.freeze({
    name: "website_change_apply",
    description: "Apply one exact backend-prepared static_web change and enter human review.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        prepared_change_id: PREPARED_CHANGE_ID_SCHEMA,
      },
      ["project_id", "prepared_change_id"],
    ),
  }),  Object.freeze({
    name: "website_build_check",
    description: "Validate the exact active static_web change without returning source or raw logs.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        operation_id: OPERATION_ID_SCHEMA,
        operation_revision: OPERATION_REVISION_SCHEMA,
        expected_workspace_digest: DIGEST_SCHEMA,
      },
      ["project_id", "operation_id", "operation_revision", "expected_workspace_digest"],
    ),
  }),
  Object.freeze({
    name: "website_change_reject",
    description: "Reject the exact active reviewed change using a separately issued opaque human approval reference.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        operation_id: OPERATION_ID_SCHEMA,
        operation_revision: OPERATION_REVISION_SCHEMA,
        expected_workspace_digest: DIGEST_SCHEMA,
        approval_id: APPROVAL_REF_SCHEMA,
      },
      ["project_id", "operation_id", "operation_revision", "expected_workspace_digest", "approval_id"],
    ),
  }),
  Object.freeze({
    name: "website_change_accept",
    description: "Accept the exact active reviewed change using a separately issued opaque human approval reference. Acceptance never publishes.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        operation_id: OPERATION_ID_SCHEMA,
        operation_revision: OPERATION_REVISION_SCHEMA,
        expected_workspace_digest: DIGEST_SCHEMA,
        approval_id: APPROVAL_REF_SCHEMA,
      },
      ["project_id", "operation_id", "operation_revision", "expected_workspace_digest", "approval_id"],
    ),
  }),  Object.freeze({
    name: "website_preview_get",
    description: "Start or return an identity-bound loopback Development Preview for the exact review state.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        operation_id: OPERATION_ID_SCHEMA,
        operation_revision: OPERATION_REVISION_SCHEMA,
        expected_workspace_digest: DIGEST_SCHEMA,
      },
      ["project_id", "operation_id", "operation_revision", "expected_workspace_digest"],
    ),
  }),
  Object.freeze({
    name: "website_local_files_find",
    description: "Discover bounded metadata for files under a pre-authorized opaque local root without returning file contents or absolute paths.",
    inputSchema: closedSchema(
      {
        root_id: ROOT_ID_SCHEMA,
        query: QUERY_SCHEMA,
        extensions: EXTENSIONS_SCHEMA,
        max_results: MAX_RESULTS_SCHEMA,
      },
      ["root_id", "query", "extensions", "max_results"],
    ),
  }),
  Object.freeze({
    name: "website_asset_import",
    description: "Import one previously discovered opaque local file into the authoritative project Media Library without exposing local paths or file bytes.",
    inputSchema: closedSchema(
      {
        project_id: PROJECT_ID_SCHEMA,
        local_file_id: LOCAL_FILE_ID_SCHEMA,
        size_bytes: ASSET_SIZE_SCHEMA,
        modified_at: MODIFIED_AT_SCHEMA,
      },
      ["project_id", "local_file_id", "size_bytes", "modified_at"],
    ),
  }),
]);

const PROJECT_FIELDS = Object.freeze([
  "project_id",
  "project_type",
  "workflow_state",
  "current_workspace_digest",
  "accepted_workspace_digest",
  "accepted_snapshot_id",
  "active_operation_id",
  "active_operation_revision",
  "operation_identity_status",
  "ready_release_id",
  "active_release_id",
  "pending_external_transition",
]);

function projectBound(project, requestedProjectId) {
  return isPlainObject(project)
    && project.project_id === requestedProjectId
    && project.project_type === "static_web"
    && WORKFLOW_STATES.has(project.workflow_state)
    && validDigest(project.current_workspace_digest);
}

function projectProjection(project) {
  const projected = {};
  for (const field of PROJECT_FIELDS) {
    projected[field] = Object.hasOwn(project, field) ? project[field] : null;
  }
  const optionalIds = [
    projected.accepted_snapshot_id,
    projected.active_operation_id,
    projected.ready_release_id,
    projected.active_release_id,
  ];
  if (optionalIds.some((value) => value !== null && !validOperationId(value))) return null;
  if (projected.active_operation_revision !== null && !validOperationRevision(projected.active_operation_revision)) return null;
  if (!["none", "bound", "unavailable"].includes(projected.operation_identity_status)) return null;
  if (
    projected.operation_identity_status === "bound"
    && (projected.active_operation_id === null || !validOperationRevision(projected.active_operation_revision))
  ) return null;
  if (
    projected.operation_identity_status === "none"
    && (projected.active_operation_id !== null || projected.active_operation_revision !== null)
  ) return null;
  if (projected.accepted_workspace_digest !== null && !validDigest(projected.accepted_workspace_digest)) return null;
  if (
    projected.pending_external_transition !== null
    && !["release_prepare", "release_activate"].includes(projected.pending_external_transition)
  ) return null;
  return Object.freeze(projected);
}

function stateGate(project, args, { reviewRequired = false } = {}) {
  if (!projectBound(project, args.project_id)) return fail("BACKEND_IDENTITY_MISMATCH");
  if (project.current_workspace_digest !== args.expected_workspace_digest) {
    return fail("STALE_WORKSPACE");
  }
  if (project.operation_identity_status !== "bound" || !validOperationRevision(project.active_operation_revision)) {
    return fail("OPERATION_IDENTITY_UNAVAILABLE");
  }
  if (project.active_operation_id !== args.operation_id) {
    return fail("ACTIVE_CHANGE_MISMATCH");
  }
  if (project.active_operation_revision !== args.operation_revision) {
    return fail("ACTIVE_OPERATION_REVISION_MISMATCH");
  }
  if (reviewRequired && project.workflow_state !== "review_required") {
    return fail("REVIEW_STATE_REQUIRED");
  }
  return null;
}

function sanitizeFiles(files) {
  if (!Array.isArray(files) || files.length > 1000) return null;
  const projected = [];
  for (const entry of files) {
    if (!isPlainObject(entry) || !validWorkspacePath(entry.path)) return null;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 8 * 1024 * 1024) return null;
    projected.push(Object.freeze({ path: entry.path, size: entry.size }));
  }
  projected.sort((a, b) => a.path.localeCompare(b.path));
  return Object.freeze(projected);
}

function sanitizeFindings(findings) {
  if (!Array.isArray(findings) || findings.length > 100) return null;
  const projected = [];
  for (const finding of findings) {
    if (!isPlainObject(finding) || typeof finding.code !== "string" || !CODE_RE.test(finding.code)) {
      return null;
    }
    const findingPath = finding.path === null || finding.path === undefined
      ? null
      : finding.path;
    if (findingPath !== null && !validWorkspacePath(findingPath)) return null;
    const severity = SEVERITIES.has(finding.severity) ? finding.severity : "error";
    projected.push(Object.freeze({ code: finding.code, path: findingPath, severity }));
  }
  return Object.freeze(projected);
}

function strictIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validLocalRelativePath(value) {
  return isSafeWindowsRelativePath(value);
}

function sanitizeLocalFileResult(result, args) {
  const envelope = snapshotOwnDataFields(result, ["root_id", "files"]);
  if (!envelope || envelope.root_id !== args.root_id) return null;
  if (!Array.isArray(envelope.files) || envelope.files.length > args.max_results) return null;
  const projected = [];
  const seen = new Set();
  for (const entry of envelope.files) {
    const file = snapshotOwnDataFields(entry, [
      "local_file_id",
      "relative_path",
      "size_bytes",
      "extension",
      "modified_at",
    ]);
    if (
      !file
      || typeof file.local_file_id !== "string"
      || !LOCAL_FILE_ID_RE.test(file.local_file_id)
      || seen.has(file.local_file_id)
      || !validLocalRelativePath(file.relative_path)
      || !Number.isSafeInteger(file.size_bytes)
      || file.size_bytes < 0
      || file.size_bytes > 1024 * 1024 * 1024
      || typeof file.extension !== "string"
      || (file.extension !== "" && !EXTENSION_RE.test(file.extension))
      || file.extension !== file.extension.toLowerCase()
      || !strictIsoUtc(file.modified_at)
    ) {
      return null;
    }
    const basename = file.relative_path.split("/").at(-1);
    const dot = basename.lastIndexOf(".");
    const actualExtension = dot > 0 && dot < basename.length - 1
      ? basename.slice(dot + 1).toLowerCase()
      : "";
    if (actualExtension !== file.extension) return null;
    const requestedExtensions = args.extensions.map((value) => value.toLowerCase());
    if (requestedExtensions.length > 0 && !requestedExtensions.includes(file.extension)) return null;
    if (args.query !== "" && !basename.toLowerCase().includes(args.query.toLowerCase())) return null;
    seen.add(file.local_file_id);
    projected.push(Object.freeze({
      local_file_id: file.local_file_id,
      relative_path: file.relative_path,
      size_bytes: file.size_bytes,
      extension: file.extension,
      modified_at: file.modified_at,
    }));
  }
  projected.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return Object.freeze({
    ok: true,
    root_id: args.root_id,
    files: Object.freeze(projected),
  });
}

function sanitizeAssetImportResult(result, args) {
  const envelope = snapshotOwnDataFields(result, ["ok", "asset"]);
  if (!envelope || envelope.ok !== true) return null;
  const asset = snapshotOwnDataFields(envelope.asset, [
    "asset_id",
    "project_id",
    "source_class",
    "source_handle_digest",
    "content_digest",
    "size_bytes",
    "mime_type",
    "relative_name",
    "created_at",
  ]);
  if (
    !asset
    || typeof asset.asset_id !== "string"
    || !ASSET_ID_RE.test(asset.asset_id)
    || asset.project_id !== args.project_id
    || asset.source_class !== "local_file"
    || typeof asset.source_handle_digest !== "string"
    || !SHA256_RE.test(asset.source_handle_digest)
    || asset.source_handle_digest !== expectedSourceHandleDigest(args.local_file_id)
    || typeof asset.content_digest !== "string"
    || !SHA256_RE.test(asset.content_digest)
    || !Number.isSafeInteger(asset.size_bytes)
    || asset.size_bytes !== args.size_bytes
    || asset.size_bytes < 0
    || asset.size_bytes > MAX_ASSET_IMPORT_BYTES
    || !ASSET_MIME_TYPES.has(asset.mime_type)
    || !isSafeWindowsLocalSegment(asset.relative_name)
    || !strictIsoUtc(asset.created_at)
  ) {
    return null;
  }
  return Object.freeze({
    ok: true,
    asset: Object.freeze({
      asset_id: asset.asset_id,
      project_id: asset.project_id,
      source_class: asset.source_class,
      source_handle_digest: asset.source_handle_digest,
      content_digest: asset.content_digest,
      size_bytes: asset.size_bytes,
      mime_type: asset.mime_type,
      relative_name: asset.relative_name,
      created_at: asset.created_at,
    }),
  });
}

function sanitizePreparedChangeResult(result, args, { requiredState = null } = {}) {
  const change = snapshotOwnDataFields(result, [
    "ok",
    "state",
    "project_id",
    "prepared_change_id",
    "operation_id",
    "operation_revision",
    "baseline_workspace_digest",
    "target_workspace_digest",
    "plan_digest",
  ]);
  if (
    !change
    || change.ok !== true
    || !["prepared", "applied"].includes(change.state)
    || (requiredState !== null && change.state !== requiredState)
    || change.project_id !== args.project_id
    || typeof change.prepared_change_id !== "string"
    || !PREPARED_CHANGE_ID_RE.test(change.prepared_change_id)
    || typeof change.operation_id !== "string"
    || !validOperationId(change.operation_id)
    || !validDigest(change.baseline_workspace_digest)
    || !validDigest(change.target_workspace_digest)
    || change.baseline_workspace_digest === change.target_workspace_digest
    || !validDigest(change.plan_digest)
  ) return null;
  if (
    Object.hasOwn(args, "expected_workspace_digest")
    && change.baseline_workspace_digest !== args.expected_workspace_digest
  ) return null;
  if (
    Object.hasOwn(args, "prepared_change_id")
    && change.prepared_change_id !== args.prepared_change_id
  ) return null;

  if (change.state === "prepared") {
    if (change.operation_revision !== null) return null;
  } else if (!validOperationRevision(change.operation_revision)) {
    return null;
  }

  const projected = {
    prepared_change_id: change.prepared_change_id,
    operation_id: change.operation_id,
    operation_revision: change.operation_revision,
    baseline_workspace_digest: change.baseline_workspace_digest,
    target_workspace_digest: change.target_workspace_digest,
    plan_digest: change.plan_digest,
  };
  if (change.state === "applied") {
    const workspaceDescriptor = Object.getOwnPropertyDescriptor(result, "workspace_digest");
    if (
      !workspaceDescriptor
      || workspaceDescriptor.enumerable !== true
      || !Object.hasOwn(workspaceDescriptor, "value")
      || workspaceDescriptor.value !== change.target_workspace_digest
    ) return null;
    projected.workspace_digest = workspaceDescriptor.value;
  }
  return Object.freeze(projected);
}

function sanitizeHumanTransitionResult(result, args, {
  backendTransition,
  authorizationId,
}) {
  const envelope = snapshotOwnDataFields(result, [
    "ok",
    "transition",
    "authorization_id",
    "state",
  ]);
  if (
    !envelope
    || envelope.ok !== true
    || envelope.transition !== backendTransition
    || envelope.authorization_id !== authorizationId
  ) return null;
  const projected = projectProjection(envelope.state);
  if (!projected || projected.project_id !== args.project_id) return null;

  if (backendTransition === "accept") {
    if (
      projected.workflow_state !== "accepted"
      || projected.current_workspace_digest !== args.expected_workspace_digest
      || projected.accepted_workspace_digest !== args.expected_workspace_digest
      || projected.accepted_snapshot_id === null
      || projected.active_operation_id !== args.operation_id
      || projected.active_operation_revision !== args.operation_revision
      || projected.operation_identity_status !== "bound"
    ) return null;
  } else if (backendTransition === "reject") {
    if (
      projected.workflow_state !== "working"
      || projected.active_operation_id !== null
      || projected.active_operation_revision !== null
      || projected.operation_identity_status !== "none"
      || projected.accepted_workspace_digest === null
      || projected.current_workspace_digest !== projected.accepted_workspace_digest
    ) return null;
  } else {
    return null;
  }
  return projected;
}

function sameProjectedProject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapPreparedChangeDenial(raw) {
  if (!isPlainObject(raw) || raw.ok !== false || typeof raw.error_code !== "string") return null;
  const mapped = new Map([
    ["change_request_invalid", "REQUEST_INVALID"],
    ["change_plan_invalid", "CHANGE_PLAN_INVALID"],
    ["change_project_not_found", "PROJECT_NOT_FOUND"],
    ["change_state_invalid", "CHANGE_STATE_INVALID"],
    ["change_workspace_stale", "STALE_WORKSPACE"],
    ["change_operation_conflict", "ACTIVE_CHANGE_MISMATCH"],
    ["change_active", "ACTIVE_CHANGE_MISMATCH"],
    ["change_noop", "CHANGE_NOOP"],
    ["change_idempotency_conflict", "CHANGE_IDEMPOTENCY_CONFLICT"],
    ["change_capacity", "CHANGE_CAPACITY"],
    ["change_id_collision", "CHANGE_ID_COLLISION"],
    ["prepared_change_not_found", "PREPARED_CHANGE_NOT_FOUND"],
    ["change_target_mismatch", "CHANGE_TARGET_MISMATCH"],
    ["change_record_conflict", "CHANGE_RECORD_CONFLICT"],
  ]);
  return mapped.has(raw.error_code) ? fail(mapped.get(raw.error_code)) : fail("CHANGE_DENIED");
}

function mapHumanTransitionDenial(raw) {
  if (!isPlainObject(raw) || raw.ok !== false || typeof raw.error_code !== "string") return null;
  const code = raw.error_code;
  if (code.startsWith("authorization_")) return fail("APPROVAL_REJECTED");
  if (code === "idempotency_conflict") return fail("CHANGE_IDEMPOTENCY_CONFLICT");
  if (code === "workspace_digest_mismatch" || code === "workspace_digest_drift") {
    return fail("STALE_WORKSPACE");
  }
  if (code === "operation_mismatch") return fail("ACTIVE_CHANGE_MISMATCH");
  if (code === "operation_revision_mismatch") return fail("ACTIVE_OPERATION_REVISION_MISMATCH");
  if (code === "operation_revision_unavailable" || code === "operation_revision_state_invalid") {
    return fail("OPERATION_IDENTITY_UNAVAILABLE");
  }
  if (code === "transition_not_allowed") return fail("REVIEW_STATE_REQUIRED");
  return fail("CHANGE_TRANSITION_DENIED");
}
function validLoopbackPreview(preview, args) {
  if (!isPlainObject(preview)) return false;
  if (!validOperationId(preview.preview_id)) return false;
  if (preview.project_id !== args.project_id) return false;
  if (preview.workspace_digest !== args.expected_workspace_digest) return false;
  let parsed;
  try {
    parsed = new URL(preview.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return false;
  if (parsed.username || parsed.password || parsed.hash || parsed.search) return false;
  if (!parsed.port || !/^\d{2,5}$/.test(parsed.port)) return false;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const tokenMatch = /^\/preview\/([a-f0-9]{64})\/index\.html$/.exec(parsed.pathname);
  if (!tokenMatch) return false;
  if (typeof preview.token !== "string" || !/^[a-f0-9]{64}$/.test(preview.token)) return false;
  if (tokenMatch[1] !== preview.token) return false;
  if (Object.hasOwn(preview, "host") && preview.host !== "127.0.0.1") return false;
  if (Object.hasOwn(preview, "port") && preview.port !== port) return false;
  if (typeof preview.close !== "function") return false;
  return true;
}

function previewCloseError() {
  const error = new Error("preview_close_failed");
  error.code = "preview_close_failed";
  return error;
}

function requireBackend(backend) {
  if (!isPlainObject(backend)) throw new TypeError("backend_adapter_required");
  for (const method of [
    "getProject",
    "listWorkspaceFiles",
    "validateWorkspace",
    "startDevelopmentPreview",
  ]) {
    if (typeof backend[method] !== "function") {
      throw new TypeError(`backend_${method}_required`);
    }
  }
}

export function createStaticWebsiteToolset({
  backend,
  localFiles = null,
  approvals = null,
  previewTtlMs = 300_000,
  maxCachedPreviews = 8,
  scheduler = {
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle);
    },
  },
}) {
  requireBackend(backend);
  if (
    localFiles !== null
    && (!isPlainObject(localFiles) || typeof localFiles.findLocalFiles !== "function")
  ) {
    throw new TypeError("local_files_adapter_invalid");
  }
  if (
    approvals !== null
    && (!isPlainObject(approvals) || typeof approvals.resolveApproval !== "function")
  ) {
    throw new TypeError("approval_resolver_invalid");
  }
  const assetImportComposed = localFiles !== null
    && typeof localFiles.getLocalFileImportBinding === "function"
    && typeof localFiles.statLocalFile === "function"
    && typeof localFiles.readLocalFile === "function"
    && typeof backend.importLocalAsset === "function";
  const mutationComposed = typeof backend.prepareChange === "function"
    && typeof backend.applyPreparedChange === "function";
  const reviewDecisionComposed = mutationComposed
    && approvals !== null
    && typeof backend.acceptChange === "function"
    && typeof backend.rejectChange === "function";
  if (!Number.isInteger(previewTtlMs) || previewTtlMs < 1_000 || previewTtlMs > 3_600_000) {
    throw new TypeError("preview_ttl_invalid");
  }
  if (!Number.isInteger(maxCachedPreviews) || maxCachedPreviews < 1 || maxCachedPreviews > 32) {
    throw new TypeError("preview_cache_limit_invalid");
  }
  if (
    !scheduler
    || typeof scheduler.setTimeout !== "function"
    || typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("preview_scheduler_invalid");
  }
  const previewCache = new Map();
  const previewResources = new Set();
  let previewQueue = Promise.resolve();
  let closePromise = null;
  let closing = false;
  let closed = false;

  function withPreviewLock(operation) {
    const run = previewQueue.then(operation, operation);
    previewQueue = run.catch(() => {});
    return run;
  }

  async function getBoundProject(projectId) {
    const project = await backend.getProject(projectId);
    if (project === null || project === undefined) return { error: fail("PROJECT_UNAVAILABLE") };
    if (!projectBound(project, projectId)) {
      return { error: fail("BACKEND_IDENTITY_MISMATCH") };
    }
    return { project };
  }

  async function projectStatus(args) {
    const bound = await getBoundProject(args.project_id);
    if (bound.error) return bound.error;
    const project = projectProjection(bound.project);
    if (!project) return fail("BACKEND_RESPONSE_INVALID");
    return Object.freeze({
      ok: true,
      project,
    });
  }

  async function projectInspect(args) {
    const bound = await getBoundProject(args.project_id);
    if (bound.error) return bound.error;
    if (bound.project.current_workspace_digest !== args.expected_workspace_digest) {
      return fail("STALE_WORKSPACE");
    }
    const files = sanitizeFiles(await backend.listWorkspaceFiles(
      args.project_id,
      args.expected_workspace_digest,
    ));
    if (!files) return fail("BACKEND_RESPONSE_INVALID");
    const after = await getBoundProject(args.project_id);
    if (after.error) return after.error;
    if (after.project.current_workspace_digest !== args.expected_workspace_digest) {
      return fail("STALE_WORKSPACE");
    }
    return Object.freeze({
      ok: true,
      project_id: args.project_id,
      workspace_digest: args.expected_workspace_digest,
      files,
    });
  }

  async function buildCheck(args) {
    const bound = await getBoundProject(args.project_id);
    if (bound.error) return bound.error;
    const gate = stateGate(bound.project, args);
    if (gate) return gate;
    if (!["change_active", "review_required"].includes(bound.project.workflow_state)) {
      return fail("ACTIVE_CHANGE_REQUIRED");
    }

    const validation = await backend.validateWorkspace({
      project_id: args.project_id,
      operation_id: args.operation_id,
      operation_revision: args.operation_revision,
      expected_workspace_digest: args.expected_workspace_digest,
    });
    if (
      !isPlainObject(validation)
      || validation.project_id !== args.project_id
      || validation.workspace_digest !== args.expected_workspace_digest
      || typeof validation.ok !== "boolean"
    ) {
      return fail("BACKEND_IDENTITY_MISMATCH");
    }
    const findings = sanitizeFindings(validation.findings ?? []);
    if (!findings) return fail("BACKEND_RESPONSE_INVALID");
    const after = await getBoundProject(args.project_id);
    if (after.error) return after.error;
    const afterGate = stateGate(after.project, args);
    if (afterGate) return afterGate;
    if (!["change_active", "review_required"].includes(after.project.workflow_state)) {
      return fail("ACTIVE_CHANGE_REQUIRED");
    }
    return Object.freeze({
      ok: true,
      validation: Object.freeze({
        valid: validation.ok,
        project_id: args.project_id,
        operation_id: args.operation_id,
        operation_revision: args.operation_revision,
        workspace_digest: args.expected_workspace_digest,
        findings,
      }),
    });
  }

  async function closePreviewEntry(entry) {
    try {
      if (typeof entry?.preview?.close !== "function") throw previewCloseError();
      await entry.preview.close();
    } catch (error) {
      if (error?.code === "preview_close_failed") throw error;
      throw previewCloseError();
    }

    if (entry.timer !== null) {
      try { scheduler.clearTimeout(entry.timer); } catch {}
      entry.timer = null;
    }
    if (entry.cacheKey !== null && previewCache.get(entry.cacheKey) === entry) {
      previewCache.delete(entry.cacheKey);
    }
    previewResources.delete(entry);
  }

  async function closeCachedPreview(cacheKey, entry) {
    if (previewCache.get(cacheKey) !== entry) return;
    await closePreviewEntry(entry);
  }

  async function evictProjectPreviews(projectId, keepKey) {
    for (const [key, entry] of [...previewCache.entries()]) {
      if (key === keepKey) continue;
      if (entry.project_id !== projectId) continue;
      await closeCachedPreview(key, entry);
    }
  }

  async function ensurePreviewCapacity() {
    while (previewResources.size >= maxCachedPreviews) {
      const oldest = previewResources.values().next().value;
      if (!oldest) return;
      await closePreviewEntry(oldest);
    }
  }

  async function previewGet(args) {
    return withPreviewLock(async () => {
      if (closing || closed) return fail("TOOLSET_CLOSED");

      const bound = await getBoundProject(args.project_id);
      if (bound.error) return bound.error;
      const gate = stateGate(bound.project, args, { reviewRequired: true });
      if (gate) return gate;

      const cacheKey = [
      args.project_id,
      args.operation_id,
      args.operation_revision,
      args.expected_workspace_digest,
    ].join("\0");
      await evictProjectPreviews(args.project_id, cacheKey);
      const cached = previewCache.get(cacheKey);
      if (cached) {
        if (cached.expired === true) {
          await closePreviewEntry(cached);
        } else {
          return cached.projection;
        }
      }

      await ensurePreviewCapacity();
      if (closing || closed) return fail("TOOLSET_CLOSED");

      let preview;
      try {
        preview = await backend.startDevelopmentPreview({
          project_id: args.project_id,
          operation_id: args.operation_id,
          operation_revision: args.operation_revision,
          expected_workspace_digest: args.expected_workspace_digest,
        });
      } catch (error) {
        const cleanupPreview = error?.preview_cleanup_resource;
        if (
          error?.code === "preview_close_failed"
          && cleanupPreview
          && typeof cleanupPreview === "object"
        ) {
          previewResources.add({
            project_id: args.project_id,
            preview: cleanupPreview,
            projection: null,
            timer: null,
            cacheKey: null,
          });
        }
        throw error;
      }
      const entry = {
        project_id: args.project_id,
        preview,
        projection: null,
        timer: null,
        cacheKey: null,
        expired: false,
      };
      previewResources.add(entry);

      if (!validLoopbackPreview(preview, args)) {
        await closePreviewEntry(entry);
        return fail("BACKEND_IDENTITY_MISMATCH");
      }

      const after = await getBoundProject(args.project_id);
      if (after.error) {
        await closePreviewEntry(entry);
        return after.error;
      }
      const afterGate = stateGate(after.project, args, { reviewRequired: true });
      if (afterGate) {
        await closePreviewEntry(entry);
        return afterGate;
      }
      if (closing || closed) {
        await closePreviewEntry(entry);
        return fail("TOOLSET_CLOSED");
      }

      const projection = Object.freeze({
        ok: true,
        preview: Object.freeze({
          preview_id: preview.preview_id,
          project_id: args.project_id,
          operation_id: args.operation_id,
          operation_revision: args.operation_revision,
          workspace_digest: args.expected_workspace_digest,
          url: preview.url,
        }),
      });
      entry.projection = projection;
      entry.cacheKey = cacheKey;
      previewCache.set(cacheKey, entry);
      entry.timer = scheduler.setTimeout(
        () => {
          entry.expired = true;
          void withPreviewLock(() => closeCachedPreview(cacheKey, entry)).catch(() => {});
        },
        previewTtlMs,
      );
      return projection;
    });
  }

  async function localFilesFind(args) {
    if (!localFiles) return fail("CAPABILITY_UNAVAILABLE");
    const raw = await localFiles.findLocalFiles({
      root_id: args.root_id,
      query: args.query,
      extensions: [...args.extensions],
      max_results: args.max_results,
    });
    return sanitizeLocalFileResult(raw, args) ?? fail("LOCAL_FILE_SOURCE_INVALID");
  }

  async function assetImport(args) {
    if (!assetImportComposed) return fail("CAPABILITY_UNAVAILABLE");
    const rawBinding = await localFiles.getLocalFileImportBinding(args.local_file_id);
    if (rawBinding === null || rawBinding === undefined) return fail("LOCAL_FILE_STALE");
    const binding = trustedAssetImportBinding(rawBinding, args);
    if (binding === false) return fail("LOCAL_FILE_STALE");
    if (binding === null) return fail("LOCAL_FILE_SOURCE_INVALID");

    const raw = await backend.importLocalAsset({
      project_id: args.project_id,
      local_file_id: args.local_file_id,
      expected_source: {
        size_bytes: args.size_bytes,
        modified_at: args.modified_at,
      },
      expected_content_digest: binding.content_digest,
      idempotency_key: assetImportIdempotencyKey(args),
    });
    return sanitizeAssetImportResult(raw, args) ?? fail("ASSET_RESPONSE_INVALID");
  }

  async function changePrepare(args) {
    if (!mutationComposed) return fail("CAPABILITY_UNAVAILABLE");
    const bound = await getBoundProject(args.project_id);
    if (bound.error) return bound.error;
    if (bound.project.current_workspace_digest !== args.expected_workspace_digest) {
      return fail("STALE_WORKSPACE");
    }
    const canonical = canonicalChangePrepareRequest(args);
    const idempotencyKey = changePrepareIdempotencyKey(args);
    if (!canonical || !idempotencyKey) return fail("REQUEST_INVALID");

    const raw = await backend.prepareChange({
      project_id: canonical.project_id,
      expected_workspace_digest: canonical.expected_workspace_digest,
      operations: canonical.operations.map((operation) => Object.freeze({ ...operation })),
      idempotency_key: idempotencyKey,
    });
    if (isPlainObject(raw) && raw.ok === false) {
      return mapPreparedChangeDenial(raw) ?? fail("CHANGE_DENIED");
    }
    const change = sanitizePreparedChangeResult(raw, args, {
      requiredState: "prepared",
    });
    if (!change) return fail("CHANGE_RESPONSE_INVALID");
    return Object.freeze({ ok: true, change });
  }

  async function changeApply(args) {
    if (!mutationComposed) return fail("CAPABILITY_UNAVAILABLE");
    const raw = await backend.applyPreparedChange({
      project_id: args.project_id,
      prepared_change_id: args.prepared_change_id,
    });
    if (isPlainObject(raw) && raw.ok === false) {
      return mapPreparedChangeDenial(raw) ?? fail("CHANGE_DENIED");
    }
    const change = sanitizePreparedChangeResult(raw, args, {
      requiredState: "applied",
    });
    if (!change) return fail("CHANGE_RESPONSE_INVALID");

    const bound = await getBoundProject(args.project_id);
    if (bound.error) return bound.error;
    const gate = stateGate(bound.project, {
      project_id: args.project_id,
      operation_id: change.operation_id,
      operation_revision: change.operation_revision,
      expected_workspace_digest: change.workspace_digest,
    }, { reviewRequired: true });
    if (gate) {
      if (gate.error_code === "REVIEW_STATE_REQUIRED") {
        return fail("CHANGE_REVIEW_STATE_INVALID");
      }
      return gate;
    }
    const projected = projectProjection(bound.project);
    if (!projected) return fail("BACKEND_RESPONSE_INVALID");
    return Object.freeze({
      ok: true,
      change,
      project: projected,
    });
  }

  async function reviewDecision(toolName, backendTransition, args) {
    if (!reviewDecisionComposed) return fail("CAPABILITY_UNAVAILABLE");
    const bound = await getBoundProject(args.project_id);
    if (bound.error) return bound.error;
    if (bound.project.workflow_state === "review_required") {
      const gate = stateGate(bound.project, args, { reviewRequired: true });
      if (gate) return gate;
    }

    const idempotencyKey = reviewDecisionIdempotencyKey(toolName, args);
    const resolverRequest = Object.freeze({
      approval_id: args.approval_id,
      tool_name: toolName,
      backend_transition: backendTransition,
      project_id: args.project_id,
      operation_id: args.operation_id,
      operation_revision: args.operation_revision,
      expected_workspace_digest: args.expected_workspace_digest,
      idempotency_key: idempotencyKey,
      caller_class: "model_orchestrator",
    });

    let authorizationEvidence;
    try {
      authorizationEvidence = await approvals.resolveApproval(resolverRequest);
    } catch {
      return fail("APPROVAL_UNAVAILABLE");
    }

    const mutationRequest = {
      project_id: args.project_id,
      operation_id: args.operation_id,
      operation_revision: args.operation_revision,
      expected_workspace_digest: args.expected_workspace_digest,
      idempotency_key: idempotencyKey,
      caller_class: "model_orchestrator",
      authorization_evidence: authorizationEvidence,
    };
    if (!hasMutationEnvelopeShape(mutationRequest, { expectedTransition: toolName })) {
      return fail("APPROVAL_INVALID");
    }

    const backendMethod = backendTransition === "accept"
      ? backend.acceptChange
      : backend.rejectChange;
    const raw = await backendMethod(mutationRequest);
    if (isPlainObject(raw) && raw.ok === false) {
      return mapHumanTransitionDenial(raw) ?? fail("CHANGE_TRANSITION_DENIED");
    }
    const projected = sanitizeHumanTransitionResult(raw, args, {
      backendTransition,
      authorizationId: authorizationEvidence.authorization_id,
    });
    if (!projected) return fail("CHANGE_RESPONSE_INVALID");

    const after = await getBoundProject(args.project_id);
    if (after.error) return after.error;
    const authoritative = projectProjection(after.project);
    if (!authoritative || !sameProjectedProject(authoritative, projected)) {
      return fail("CHANGE_STATE_DRIFT");
    }

    return Object.freeze({
      ok: true,
      transition: backendTransition,
      project: projected,
    });
  }

  async function changeAccept(args) {
    return reviewDecision("website_change_accept", "accept", args);
  }

  async function changeReject(args) {
    return reviewDecision("website_change_reject", "reject", args);
  }
  const visibleTools = Object.freeze(
    TOOL_DEFINITIONS.filter((tool) => {
      if (tool.name === "website_local_files_find") return localFiles !== null;
      if (tool.name === "website_asset_import") return assetImportComposed;
      if (["website_change_prepare", "website_change_apply"].includes(tool.name)) {
        return mutationComposed;
      }
      if (["website_change_accept", "website_change_reject"].includes(tool.name)) {
        return reviewDecisionComposed;
      }
      return true;
    }),
  );

  const handlers = Object.freeze({
    website_project_status: projectStatus,
    website_project_inspect: projectInspect,
    website_build_check: buildCheck,
    website_preview_get: previewGet,
    website_local_files_find: localFilesFind,
    website_asset_import: assetImport,
    website_change_prepare: changePrepare,
    website_change_apply: changeApply,
    website_change_reject: changeReject,
    website_change_accept: changeAccept,
  });

  async function callTool(name, args) {
    if (!DECLARED_SET.has(name)) return fail("TOOL_NOT_FOUND");
    if (!EXECUTABLE_SET.has(name)) return fail("CAPABILITY_UNAVAILABLE");
    if (name === "website_local_files_find" && localFiles === null) {
      return fail("CAPABILITY_UNAVAILABLE");
    }
    if (name === "website_asset_import" && !assetImportComposed) {
      return fail("CAPABILITY_UNAVAILABLE");
    }
    if (
      ["website_change_prepare", "website_change_apply"].includes(name)
      && !mutationComposed
    ) return fail("CAPABILITY_UNAVAILABLE");
    if (
      ["website_change_accept", "website_change_reject"].includes(name)
      && !reviewDecisionComposed
    ) return fail("CAPABILITY_UNAVAILABLE");
    if (closing || closed) return fail("TOOLSET_CLOSED");

    const valid = name === "website_project_status"
      ? validateStatusRequest(args)
      : name === "website_project_inspect"
        ? validateDigestBoundRequest(args)
        : name === "website_local_files_find"
          ? validateLocalFilesRequest(args)
          : name === "website_asset_import"
            ? validateAssetImportRequest(args)
            : name === "website_change_prepare"
              ? validateChangePrepareRequest(args)
              : name === "website_change_apply"
                ? validateChangeApplyRequest(args)
                : ["website_change_accept", "website_change_reject"].includes(name)
                  ? validateReviewDecisionRequest(args)
                  : validateOperationBoundRequest(args);
    if (!valid) return fail("REQUEST_INVALID");

    try {
      return await handlers[name](args);
    } catch (error) {
      if (error?.code === "workspace_digest_mismatch") return fail("STALE_WORKSPACE");
      if (error?.code === "operation_revision_mismatch") {
        return fail("ACTIVE_OPERATION_REVISION_MISMATCH");
      }
      if (error?.code === "operation_mismatch") return fail("ACTIVE_CHANGE_MISMATCH");
      if (error?.code === "operation_identity_unavailable") {
        return fail("OPERATION_IDENTITY_UNAVAILABLE");
      }
      if (error?.code === "preview_close_failed") return fail("PREVIEW_CLOSE_FAILED");
      if (error?.code === "local_file_root_unavailable") return fail("LOCAL_FILE_ROOT_UNAVAILABLE");
      if (error?.code === "local_file_source_failure") return fail("LOCAL_FILE_SOURCE_FAILURE");
      if (
        error?.code === "local_file_source_invalid"
        || error?.code === "local_file_id_collision"
        || error?.code === "local_file_id_invalid"
      ) return fail("LOCAL_FILE_SOURCE_INVALID");
      if (name === "website_local_files_find") return fail("LOCAL_FILE_SOURCE_FAILURE");
      if (
        [
          "website_change_prepare",
          "website_change_apply",
          "website_change_accept",
          "website_change_reject",
        ].includes(name)
      ) {
        return fail("CHANGE_BACKEND_FAILURE");
      }
      if (name === "website_asset_import") {
        if (error?.code === "asset_project_unavailable") return fail("ASSET_PROJECT_UNAVAILABLE");
        if (error?.code === "asset_source_stale") return fail("LOCAL_FILE_STALE");
        if (error?.code === "asset_source_changed") return fail("LOCAL_FILE_CHANGED");
        if (error?.code === "asset_content_digest_mismatch") return fail("LOCAL_FILE_CHANGED");
        if (error?.code === "asset_too_large") return fail("ASSET_TOO_LARGE");
        if (
          error?.code === "asset_type_unsupported"
          || error?.code === "asset_type_mismatch"
        ) return fail("ASSET_TYPE_UNSUPPORTED");
        if (error?.code === "asset_idempotency_conflict") {
          return fail("ASSET_IDEMPOTENCY_CONFLICT");
        }
        return fail("ASSET_IMPORT_FAILURE");
      }
      return fail("BACKEND_FAILURE");
    }
  }

  async function close() {
    if (closed) return;
    if (closePromise) return closePromise;

    closing = true;
    closePromise = withPreviewLock(async () => {
      let firstError = null;
      for (const entry of [...previewResources]) {
        try {
          await closePreviewEntry(entry);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (previewResources.size > 0) {
        throw firstError ?? previewCloseError();
      }
      closed = true;
    });

    try {
      await closePromise;
    } finally {
      closePromise = null;
    }
  }

  const runtimeStatus = Object.freeze({
    executable_tools: true,
    executable_tool_names: Object.freeze(visibleTools.map((tool) => tool.name)),
    local_files_composed: localFiles !== null,
    asset_import_composed: assetImportComposed,
    mutation_composed: mutationComposed,
    review_decision_composed: reviewDecisionComposed,
  });

  return Object.freeze({
    tools: visibleTools,
    status: runtimeStatus,
    callTool,
    close,
  });
}
