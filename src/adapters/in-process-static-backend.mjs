function requiredMethod(target, name, owner) {
  if (!target || typeof target[name] !== "function") {
    throw new TypeError(`${owner}_${name}_required`);
  }
}

function failWorkspaceDigest() {
  const error = new Error("workspace_digest_mismatch");
  error.code = "workspace_digest_mismatch";
  throw error;
}

function failOperationRevision(code = "operation_revision_mismatch") {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function previewCloseFailure(preview) {
  const error = new Error("preview_close_failed");
  error.code = "preview_close_failed";
  Object.defineProperty(error, "preview_cleanup_resource", {
    value: preview,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

function verifyOperationFence(lifecycle, {
  project_id,
  operation_id,
  operation_revision,
}) {
  const project = lifecycle.getProject(project_id);
  if (!project || project.operation_identity_status !== "bound") {
    failOperationRevision("operation_identity_unavailable");
  }
  if (project.active_operation_id !== operation_id) {
    failOperationRevision("operation_mismatch");
  }
  if (project.active_operation_revision !== operation_revision) {
    failOperationRevision("operation_revision_mismatch");
  }
  return project;
}

export function createInProcessStaticBackendAdapter({
  lifecycle,
  workspace,
  validateWorkspace,
  startDevelopmentPreview,
  assetLibrary = null,
  changeAuthority = null,
}) {
  requiredMethod(lifecycle, "getProject", "lifecycle");
  requiredMethod(workspace, "listFiles", "workspace");
  requiredMethod(workspace, "computeDigest", "workspace");
  if (typeof validateWorkspace !== "function") {
    throw new TypeError("validate_workspace_required");
  }
  if (typeof startDevelopmentPreview !== "function") {
    throw new TypeError("start_development_preview_required");
  }
  if (assetLibrary !== null) {
    requiredMethod(assetLibrary, "importLocalAsset", "asset_library");
  }
  if (changeAuthority !== null) {
    requiredMethod(changeAuthority, "prepareChange", "change_authority");
    requiredMethod(changeAuthority, "applyPreparedChange", "change_authority");
    requiredMethod(lifecycle, "executeHumanTransition", "lifecycle");
  }

  const adapter = {
    getProject(projectId) {
      return lifecycle.getProject(projectId);
    },

    listWorkspaceFiles(projectId, expectedWorkspaceDigest) {
      const before = workspace.computeDigest(projectId);
      if (before !== expectedWorkspaceDigest) failWorkspaceDigest();
      const files = workspace.listFiles(projectId);
      const after = workspace.computeDigest(projectId);
      if (after !== expectedWorkspaceDigest) failWorkspaceDigest();
      return files;
    },

    async validateWorkspace({
      project_id,
      operation_id,
      operation_revision,
      expected_workspace_digest,
    }) {
      verifyOperationFence(lifecycle, { project_id, operation_id, operation_revision });
      const before = workspace.computeDigest(project_id);
      if (before !== expected_workspace_digest) failWorkspaceDigest();
      const result = await validateWorkspace({
        workspace,
        project_id,
        expected_workspace_digest,
      });
      const after = workspace.computeDigest(project_id);
      if (after !== expected_workspace_digest) failWorkspaceDigest();
      verifyOperationFence(lifecycle, { project_id, operation_id, operation_revision });
      return result;
    },

    async startDevelopmentPreview({
      project_id,
      operation_id,
      operation_revision,
      expected_workspace_digest,
    }) {
      verifyOperationFence(lifecycle, { project_id, operation_id, operation_revision });
      const before = workspace.computeDigest(project_id);
      if (before !== expected_workspace_digest) failWorkspaceDigest();
      const preview = await startDevelopmentPreview({
        workspace,
        project_id,
        expected_workspace_digest,
      });
      try {
        const after = workspace.computeDigest(project_id);
        if (after !== expected_workspace_digest) failWorkspaceDigest();
        verifyOperationFence(lifecycle, { project_id, operation_id, operation_revision });
        return preview;
      } catch (error) {
        try {
          if (typeof preview?.close !== "function") throw new Error("preview_close_missing");
          await preview.close();
        } catch {
          throw previewCloseFailure(preview);
        }
        throw error;
      }
    },
  };
  if (assetLibrary !== null) {
    adapter.importLocalAsset = (request) => assetLibrary.importLocalAsset(request);
  }
  if (changeAuthority !== null) {
    adapter.prepareChange = (request) => changeAuthority.prepareChange(request);
    adapter.applyPreparedChange = (request) => changeAuthority.applyPreparedChange(request);
    adapter.acceptChange = (request) => lifecycle.executeHumanTransition({
      transition: "accept",
      request,
    });
    adapter.rejectChange = (request) => lifecycle.executeHumanTransition({
      transition: "reject",
      request,
    });
  }
  return Object.freeze(adapter);
}
