# Codebase audit note

Audit date: 2026-09-26.

Available preserved source inspected:
- private backup repo HEAD `ca7134bf3e45a940bc17733a1b6c510c640fcdc3`;
- `product/codebase44-core` sparse checkout from that backup;
- latest preserved Preview/Dashboard snapshot points to source commit `40af0adb16b2ec46fd5f86fa45dd3623c2aee156`;
- older private `CB44` comparison HEAD `813e5913b5dd950dde18e15991b550aa4b98f67e`.

Core provenance records earlier extraction from `codebase-brain` commit `5663944eaef23b7f99a07720cc8a96d30fdb5054`.

Graphify was run locally with `--code-only`: 192 code files, 3921 nodes and 8827 edges. No external semantic/LLM extraction was used.

The MCP repository should reuse concepts and backend APIs, not copy old Product Connector OAuth/lab/Windows runtime transport code. Exact implementation reuse remains blocked on provenance/license review because this repository is public.
