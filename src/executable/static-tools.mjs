import { WEBSITE_TOOL_NAMES } from "../contracts/tool-names.mjs";

export const EXECUTABLE_WEBSITE_TOOL_NAMES = Object.freeze([
  "website_project_status",
  "website_project_inspect",
  "website_build_check",
  "website_preview_get",
]);

const EXECUTABLE_SET = new Set(EXECUTABLE_WEBSITE_TOOL_NAMES);
const DECLARED_SET = new Set(WEBSITE_TOOL_NAMES);
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OPERATION_REVISION_RE = /^[1-9][0-9]{0,19}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
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

function closedSchema(properties, required) {
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze([...required]),
    additionalProperties: false,
  });
}

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

  const handlers = Object.freeze({
    website_project_status: projectStatus,
    website_project_inspect: projectInspect,
    website_build_check: buildCheck,
    website_preview_get: previewGet,
  });

  async function callTool(name, args) {
    if (!DECLARED_SET.has(name)) return fail("TOOL_NOT_FOUND");
    if (!EXECUTABLE_SET.has(name)) return fail("CAPABILITY_UNAVAILABLE");
    if (closing || closed) return fail("TOOLSET_CLOSED");

    const valid = name === "website_project_status"
      ? validateStatusRequest(args)
      : name === "website_project_inspect"
        ? validateDigestBoundRequest(args)
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

  return Object.freeze({
    tools: TOOL_DEFINITIONS,
    callTool,
    close,
  });
}
