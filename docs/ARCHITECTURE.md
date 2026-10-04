# Architecture boundary

## Composition

```text
ChatGPT
  -> Owned MCP policy / approval / audit boundary
      -> MCP-RDC-web-build website orchestration
          -> stock Desktop Commander execution primitives
          -> RDC-web-build-backend managed website lifecycle
```

Stock Desktop Commander remains unchanged by this project.

## Phase 1

Only `static_web` is an active product contract.

The orchestration layer may request bounded operations, but managed website state remains backend-authoritative. Low-level RDC execution must not silently bypass the managed lifecycle.

## Gated transitions

The backend owns the authoritative transitions for:

1. review decision: Accept or Reject;
2. Release Prepare;
3. Release Activate.

These remain distinct transitions even if a future human-facing UI offers a convenience flow that sequences them.

## Mutation envelope

Every future mutating orchestration request must bind to an explicit project plus:

- operation ID;
- server-issued operation revision / incarnation;
- expected workspace digest;
- idempotency key;
- caller class;
- authorization evidence appropriate to the requested transition.

The orchestration validator must receive the exact gated `website_*` transition being requested. Evidence is shape-accepted only when `decision=approved` and its bound transition exactly matches that requested transition; the backend remains the actual authorization verifier and lifecycle authority.

A bounded executable read/review subset is enabled for static_web: project status, project inspect, build/validation check and identity-bound Development Preview. Build and preview require the backend's immutable operation revision in addition to project, operation ID and workspace digest, and the adapter rechecks the operation fence around awaited work. The adapter exposes only fixed backend methods and does not provide arbitrary action/method passthrough.

Prepared-change mutation is now executable when the backend adapter exposes authoritative `prepareChange` + `applyPreparedChange`: `website_change_prepare` and `website_change_apply` remain model-bounded and cannot accept caller, authorization, idempotency, absolute-path or trusted-filesystem authority.

Accept and Reject are implemented only as **conditional** human-review orchestration. They are advertised only when a trusted host injects `approvals.resolveApproval(...)` outside the ordinary model-facing MCP surface; without that resolver they remain hidden and return no product capability. This repository does not mint approvals and does not contain the Owned MCP production composition, so Accept/Reject are not yet claimed as production-ready product runtime tools.

Release Prepare and Release Activate remain unavailable. Accept is never a release or publication transition.
