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

This feature branch adds the trusted `website_asset_import` vertical. The tool is advertised only when the local-files adapter exposes the private import binding plus `statLocalFile` / `readLocalFile`, and the backend exposes Media Library `importLocalAsset` authority. Its model-facing request remains closed to `project_id + local_file_id + size_bytes + modified_at`; the model cannot provide an absolute path, bytes, caller/approval authority, content digest or idempotency key. The discovery-time content digest and deterministic retry identity are derived inside trusted composition, and the result is re-projected to bounded managed-asset metadata with project/source/size binding.

The authoritative backend Media Library cross-instance state/idempotency blocker is closed, and this branch now supplies the remaining local raw-byte bridge. `createWindowsStableFileCapture` requires an injected trusted path validator such as stock Desktop Commander `validatePath()`, rechecks exact configured-root containment, rejects unsafe Windows path/device/reparse/hard-link cases, binds opened-file identity and final path, and captures bounded bytes while a Windows `FileShare.Read` handle denies concurrent write/delete sharing. Discovery privately pins Win32 source identity plus SHA-256; same-size/same-mtime replacement and same-object content ABA fail closed. Raw bytes and absolute paths never enter the model-facing tool result. Stock `read_file` remains presentation-oriented and is not used as the generic binary provider.

Build/preview still use the fixed backend adapter boundary, closed schemas, bounded output projection and loopback-only Development Preview verification. Build and preview are bound to the exact server-issued operation incarnation `project_id + operation_id + operation_revision + workspace_digest`; the in-process adapter rechecks that fence before and after awaited backend work. Asset import does not add workspace, acceptance, release or publication authority.

Accept, Reject, Release Prepare, Release Activate, published-preview control and customer publication remain outside this executable slice. Preview != Accept != Release Prepare != Release Activate, and no asset-import path creates a silent publish shortcut.

The current local Cube reconstruction passes 118/118 tests plus syntax, public-safety, dependency-audit and diff gates. Real Windows tests cover exact byte/digest capture, hard-link and junction rejection, restored-metadata replacement, content ABA, oversized/device forms and concurrent write/rename denial. A cross-repository E2E against the current backend imports original PNG and PDF bytes into the managed Media Library, verifies exact readback, deterministic replay and stale-source denial; the E2E also passed five consecutive canary runs. Stock Desktop Commander `validatePath()` was smoke-tested against the existing allowed-directory configuration without changing that configuration. Commit/PR/CI evidence is maintained in the project Work Log and Active Work Registry. Owned MCP product composition and deployment remain separate future gates.

`"private": true` in `package.json` prevents accidental npm publication; it does not make this Git repository private.

## Development

```bash
npm test
npm run check
npm run public-safety
```
