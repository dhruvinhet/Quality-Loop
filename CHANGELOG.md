# Changelog

## Unreleased — 2026-11-03

- Warn when a recorded CAPA closure conflicts with its current Jira status category, preserving the recorded-date matching rules. Display the newest 25 strong and 25 related-revision matches and disclose additional visible search matches.
- Confirm the intended follow-up assignee, attempt assignment at creation, and fall back to unassigned only after an explicit assignee validation rejection. Add read-only task discovery and separately confirmed recovery for unconfirmed claims; never automatically create another task.
- Persist derived legacy confirmation flags with version conditions, load at most five CAPA decision views concurrently, and share invocation reads. The 3-CAPA / 15-decision simulation reduces storage reads from 16 to 10 per load.
- Pin stable Forge React 12.4.0, bridge 7.2.1 and resolver 2.0.2; regenerate the lockfile and report the production-only audit and local bundle reachability. Add the decision `taskClaimedAt` string attribute without new scopes. See [T15](docs/tasks/T15.md) for limitations and owner checks.

## Unreleased — 2026-11-02

- Bound evidence retrieval to 200 signature candidates and 20 candidates per other-related query, classify search properties and reauthorize only returned cards, and disclose caps and the 15-second load budget.
- Load matches and decisions together, validate decision saves against only the selected CAPA, cap history at 50 records per pair, and count distinct currently confirmed browsable NCs from pair state. Add the `confirmed` boolean attribute without new scopes.
- Add SIMULATED scale coverage and a dry-run-default, label-restricted REAL benchmark fixture/cleanup script. See [T14](docs/tasks/T14.md) for call counts, documentation findings and owner checks.

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
