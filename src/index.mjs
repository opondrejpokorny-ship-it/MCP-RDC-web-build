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

export const WEBSITE_TOOLSET_STATUS = Object.freeze({
  phase: "static_web_bootstrap",
  supported_project_types: Object.freeze(["static_web"]),
  executable_tools: false,
  stock_rdc_modified: false,
});
