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

The Phase 1 contract remains `static_web` only. The default core composition exposes a deliberately narrow read/review subset:

- `website_project_status`
- `website_project_inspect`
- `website_build_check`
- `website_preview_get`

An optional trusted local-files composition also exposes `website_local_files_find`. It accepts only an opaque pre-authorized `root_id` plus bounded search filters and returns opaque `local_file_id` metadata; absolute paths and file contents stay inside trusted composition.

This feature branch adds a verified orchestration checkpoint for `website_asset_import`. The tool is advertised only when both the trusted local-files adapter and a backend Media Library `importLocalAsset` authority are composed. Its model-facing request is closed to `project_id + local_file_id + size_bytes + modified_at`; the model cannot provide an absolute path, bytes, caller/approval authority or idempotency key. Exact retry identity is derived internally, and the result is re-projected to bounded managed-asset metadata with project/source/size binding.

The checkpoint does **not** make asset import production-ready by itself. Two external composition gates remain before main integration: the authoritative backend Media Library must close its cross-instance state/idempotency locking blocker, and the local-source bridge must provide identity-bound raw bytes behind Desktop Commander path/allowed-directory guardrails without routing binary payloads through ChatGPT/model-facing MCP content. Stock `read_file` is presentation-oriented and is not treated as the generic raw-byte provider for this purpose.

Build/preview still use the fixed backend adapter boundary, closed schemas, bounded output projection and loopback-only Development Preview verification. Build and preview are bound to the exact server-issued operation incarnation `project_id + operation_id + operation_revision + workspace_digest`; the in-process adapter rechecks that fence before and after awaited backend work. Asset import does not add workspace, acceptance, release or publication authority.

Accept, Reject, Release Prepare, Release Activate, published-preview control and customer publication remain outside this executable slice. Preview != Accept != Release Prepare != Release Activate, and no asset-import path creates a silent publish shortcut.

The current feature implementation passed local 94/94 tests, syntax/public-safety/audit/diff gates, Codex Terra P0/P1 review and exact-head push CI. A read-only cross-repository smoke against the current Media Library source verified import/replay shape, but production E2E remains intentionally blocked on the two gates above. Exact commit/CI evidence is maintained in the project Work Log and Active Work Registry. Owned MCP product composition and deployment remain separate future gates.

`"private": true` in `package.json` prevents accidental npm publication; it does not make this Git repository private.

## Development

```bash
npm test
npm run check
npm run public-safety
```
