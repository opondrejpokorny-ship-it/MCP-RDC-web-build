# Publication safety

This public repository uses layered publication checks.

## Automated CI gate

The existing CI runs `npm test`; the test suite includes a current-repository-tree public-safety assertion. The same scanner can also be run directly with `npm run public-safety`. It rejects common high-signal sensitive material, including:

- credential-like private GitHub URLs;
- machine-specific user/workspace paths;
- PEM private keys;
- common GitHub, OpenAI, AWS, Google, Slack and Stripe secret formats;
- database URLs containing inline credentials.

Regression tests exercise every automated rule.

## Mandatory semantic review

Pattern scanning is defense-in-depth, not proof that content is safe to publish. Before merge to a public branch, reviewers must also inspect the complete diff for:

- internal/private source provenance names or commit identities;
- copied private or third-party implementation, tests, schemas, UI or documentation;
- customer/project data;
- runtime state or protected configuration;
- misleading implemented-vs-planned claims.

Source reuse remains blocked until provenance, publication rights, required license terms and attribution are explicitly established.

## Git history

Removing a file in a later commit removes it from the current tree but not from existing Git history. History rewriting is destructive and requires separate explicit authorization.
