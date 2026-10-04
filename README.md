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

The Phase 1 contract remains `static_web` only. The executable implementation now contains the read/review, local-asset and prepared-change mutation tools:

- `website_project_status`
- `website_project_inspect`
- `website_change_prepare`
- `website_change_apply`
- `website_build_check`
- `website_preview_get`
- `website_local_files_find`
- `website_asset_import`
- conditional `website_change_accept` / `website_change_reject`

Capabilities are advertised only when their trusted dependencies are actually composed. Local discovery/import requires the trusted local-files bridge. Prepare/apply requires the backend prepared-change authority. Accept/reject additionally requires an injected trusted host `approvals.resolveApproval(...)` resolver and is hidden when that resolver is absent.

The current repository does **not** contain the Owned MCP product composition or a human-approval minting surface. Therefore `website_change_accept` and `website_change_reject` are implemented and tested orchestration paths, but they are **not claimed as production-ready product runtime capabilities yet**. The model can provide only an opaque `approval_id`; raw authorization evidence, caller class and idempotency authority are derived/resolved inside trusted composition. Product composition must inject the resolver from outside the ordinary model-facing tool surface and preserve one-time, expiring, exact-action binding.

`website_asset_import` is advertised only when the local-files adapter exposes the private import binding plus `statLocalFile` / `readLocalFile`, and the backend exposes Media Library `importLocalAsset` authority. Its model-facing request remains closed to `project_id + local_file_id + size_bytes + modified_at`; the model cannot provide an absolute path, bytes, caller/approval authority, content digest or idempotency key. `createWindowsStableFileCapture` requires an injected trusted path validator such as stock Desktop Commander `validatePath()`, rechecks configured-root containment and rejects unsafe Windows path/device/reparse/hard-link cases. Raw bytes and absolute paths never enter model-facing results.

Prepare accepts only bounded relative write/delete operations plus project and expected workspace digest. The backend returns an opaque prepared-change identity. Apply accepts only project plus that opaque ID, then re-reads authoritative project state and re-gates exact operation ID, immutable operation revision and target workspace digest. Accept/reject are exact review decisions only; neither path prepares or activates a release.

Build/preview continue to use the fixed backend adapter boundary, closed schemas, bounded output projection and loopback-only Development Preview verification. Build and preview remain bound to the exact server-issued operation incarnation `project_id + operation_id + operation_revision + workspace_digest`.

Release Prepare, Release Activate, published-preview control and customer publication remain unavailable in this slice. **Preview != Accept != Release Prepare != Release Activate.** No mutation or asset path creates a silent publish shortcut.

Current verification and integration evidence is maintained in the project Work Log and Active Work Registry. Cross-repository asset-import and mutation E2E run against an explicitly selected backend checkout. Owned MCP product composition and deployment remain separate gates.

`"private": true` in `package.json` prevents accidental npm publication; it does not make this Git repository private.

## Development

```bash
npm test
npm run check
npm run public-safety
```
