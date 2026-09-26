# MCP-RDC-web-build

Public source for the RDC Website Studio website-orchestration contract.

## Phase 1 scope

Phase 1 supports `static_web` only. The repository defines the model-facing `website_*` contract that will compose with the existing Owned MCP boundary, stock Desktop Commander execution primitives, and the separate `RDC-web-build-backend` lifecycle service.

## Responsibility

- Website-domain tool contracts and bounded orchestration.
- Composition with stock Desktop Commander for user-authorized local files, commands and repository operations.
- A backend client boundary for managed website lifecycle operations.
- Bounded state projections for project, preview, review and release status.
- Exact publication-authority handoff to the backend.

## Non-responsibility

This repository does not own managed project bytes, snapshots/history, Review/Preview state, release artifacts, release activation, stock RDC internals, or a duplicate website database.

## Publication invariant

Preview != Accept != Release Prepare != Release Activate.

The model-facing orchestration layer never grants itself acceptance or publication authority. Human authorization evidence must be validated by the authoritative backend/control boundary before a gated transition can execute.

## Source-reuse policy

This initial public repository is clean-room bootstrap code only. No private historical website-builder implementation, tests, UI, schemas, runtime state, credentials, or machine-specific artifacts are included. External or private source may be reused only after provenance and publication rights are explicitly established.

## Current status

Bootstrap contract only. The exported tool names are not executable MCP tools yet.

`"private": true` in `package.json` prevents accidental npm publication; it does not make this Git repository private.

## Development

```bash
npm test
npm run check
npm run public-safety
```
