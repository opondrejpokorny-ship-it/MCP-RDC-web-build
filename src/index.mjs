export { WEBSITE_TOOL_NAMES } from "./contracts/tool-names.mjs";
export {
  WEBSITE_MCP_OWNS,
  WEBSITE_MCP_DOES_NOT_OWN,
  GATED_TRANSITIONS,
  PUBLICATION_SEQUENCE,
} from "./contracts/boundary.mjs";
export {
  MUTATION_ENVELOPE_FIELDS,
  AUTHORIZATION_EVIDENCE_FIELDS,
  CALLER_CLASSES,
  hasMutationEnvelopeShape,
} from "./contracts/request-envelope.mjs";
export {
  EXECUTABLE_WEBSITE_TOOL_NAMES,
  createStaticWebsiteToolset,
} from "./executable/static-tools.mjs";
export {
  createInProcessStaticBackendAdapter,
} from "./adapters/in-process-static-backend.mjs";
export {
  createRdcLocalFilesAdapter,
} from "./adapters/rdc-local-files.mjs";
export {
  createWindowsStableFileCapture,
} from "./adapters/windows-stable-file-capture.mjs";

export const WEBSITE_TOOLSET_STATUS = Object.freeze({
  phase: "static_web_mutation_integration",
  supported_project_types: Object.freeze(["static_web"]),
  executable_tools: true,
  executable_tool_names: Object.freeze([
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
  ]),
  trusted_host_required_tool_names: Object.freeze([
    "website_change_reject",
    "website_change_accept",
  ]),
  review_decision_product_composed: false,
  release_tools_enabled: false,
  stock_rdc_modified: false,
});
