import test from "node:test";
import assert from "node:assert/strict";
import {
  WEBSITE_TOOL_NAMES,
  WEBSITE_MCP_DOES_NOT_OWN,
  PUBLISH_SEQUENCE,
  WEBSITE_TOOLSET_STATUS,
} from "../src/index.mjs";

test("website tool names are unique", () => {
  assert.equal(new Set(WEBSITE_TOOL_NAMES).size, WEBSITE_TOOL_NAMES.length);
});

test("publication remains a three-step explicit lifecycle", () => {
  assert.deepEqual(PUBLISH_SEQUENCE, [
    "website_change_accept",
    "website_release_prepare",
    "website_release_activate",
  ]);
});

test("MCP layer does not own backend or stock RDC authority", () => {
  assert.ok(WEBSITE_MCP_DOES_NOT_OWN.includes("managed_project_state"));
  assert.ok(WEBSITE_MCP_DOES_NOT_OWN.includes("stock_rdc_execution_primitives"));
  assert.equal(WEBSITE_TOOLSET_STATUS.executable_tools, false);
});
