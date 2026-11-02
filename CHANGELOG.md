# Changelog

## Unreleased — 2026-11-02

- Repair the lockfile's missing React DOM peer dependency for a default clean `npm ci`, preserving existing dependency versions and prerelease pins.
- Rename the npm package to `qualityloop`, add the MIT license for Dhruvinkumar Patel, and move existing task reports into `docs/tasks/` with corrected links.
- Record stable Forge dependency recommendations and full clean-install verification output in [T13](docs/tasks/T13.md). No application behaviour or manifest changes.

## 1.0.0 — 2026-11-01

- Add a release test requiring every development flag to be false and exactly the four approved scopes.
- Remove E1 indexing probes, the clipboard resource and probe property index, E2 matching checks, security self-tests, and the E8 live concurrency helper. Keep production matching, decisions, sample scenarios and issue-deletion cleanup.
- Use viewing-user Jira access throughout resolvers, reject injected issue IDs, and return safe errors with operation-only logs. Recheck sample-removal report visibility before returning issue keys.
- Replace privileged orphan discovery with an accessible-record maintenance scan. Disable manual orphan deletion: Jira's user-context 404 also means an issue cannot be browsed, so it cannot safely prove deletion. Existing deletion-event and confirmed sample cleanup remain available.
- Set package and lockfile versions to 1.0.0. No scope additions or app ID changes.

Development evaluation still falls short of the 0.95 pair-recall target (0.813; 0.938 including separate hints). See [T10.md](docs/tasks/T10.md) for the complete release audit and owner checks.
