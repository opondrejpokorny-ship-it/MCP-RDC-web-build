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

The Phase 1 contract remains `static_web` only. A deliberately narrow executable read/review subset is now implemented:

- `website_project_status`
- `website_project_inspect`
- `website_build_check`
- `website_preview_get`

These tools use a fixed backend adapter boundary, closed request schemas, bounded output projection and loopback-only Development Preview verification. Build and preview are bound to the exact server-issued operation incarnation `project_id + operation_id + operation_revision + workspace_digest`; the in-process adapter rechecks that fence before and after awaited backend work. The adapter composes with the backend without exposing arbitrary backend RPC.

All mutating, asset, Review Panel, published-preview and release tools remain declared future contract names but return capability-unavailable / are absent from the executable registry. This slice does not enable Accept, Reject, Release Prepare, Release Activate, customer publication or a silent publish shortcut.

A local cross-repository smoke has verified the executable subset against backend main `48bb175f47eea414c27839bec71969c2180c5288`, including server-issued operation revision binding, authoritative validation and an actual HTTP loopback Development Preview. Owned MCP product composition and deployment remain separate future gates.

`"private": true` in `package.json` prevents accidental npm publication; it does not make this Git repository private.

## Development

```bash
npm test
npm run check
npm run public-safety
```
