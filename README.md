# MCP-RDC-web-build

Public source for the RDC Website Studio website-orchestration layer.

## Responsibility
- Expose the planned `website_*` contract to the owning MCP composition.
- Reuse stock Desktop Commander for local file, process, command and repo execution.
- Call `RDC-web-build-backend` for managed website lifecycle state.
- Return bounded project, preview, review and release state to the model.
- Hand publication authority to the backend only after explicit human authorization.

## Non-responsibility
This repository does not own project snapshots/history, release artifacts, the Review/Preview Panel, stock RDC internals, or a duplicate website state database.

## Current status
Bootstrap only. The exported tool names are contracts, not executable MCP tools yet.

## Development
```bash
npm test
npm run check
```

No Codebase implementation source has been copied into this public repository.
