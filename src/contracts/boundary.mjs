export const WEBSITE_MCP_OWNS = Object.freeze([
  "website_tool_contracts",
  "rdc_composition",
  "backend_client_adapter",
  "bounded_state_projection",
  "publish_authority_handoff",
]);

export const WEBSITE_MCP_DOES_NOT_OWN = Object.freeze([
  "managed_project_state",
  "snapshots_or_history",
  "release_artifacts_or_activation",
  "stock_rdc_execution_primitives",
  "codebase_review_panel",
]);

export const PUBLISH_SEQUENCE = Object.freeze([
  "website_change_accept",
  "website_release_prepare",
  "website_release_activate",
]);
