# QualityLoop — T2 matching and evidence

Current behavior, owner commands, verification limits, and the complete T2 test
sequence are in [T2.md](T2.md). T2 adds deterministic matching, evidence cards,
optional CAPA narratives, and a read-only issue-context view. E1 and E2 default
to disabled. No new scopes, decisions, storage, or triggers are added.

The remaining content below is the historical T1/E1 implementation record;
its scope-change commands and no-matching description refer to T1 only.

## Historical T1/E1 record

The existing native UI Kit Jira issue panel captures quality details and prefills
them from the current issue's `qualityloop` property. T1 includes no matching,
decisions, Forge storage, or triggers.

## Owner commands

Use Node.js 22.x or 24.x. From this directory, run these commands in order.
Only the owner runs the final two commands, using the intended Forge environment
and existing Jira installation when prompted:

```powershell
npm ci
npm test
npm run lint
npm run build
forge lint --approve MAJOR_VERSION_RULE
forge deploy --approve MAJOR_VERSION_RULE
forge install --upgrade
```

The two new scopes trigger a major version change. Plain `forge lint` reports
`0 errors, 0 warnings, 1 approval` until the scope change is acknowledged.
`--approve MAJOR_VERSION_RULE` acknowledges that rule for the individual command.
Deploying and then upgrading the installation is required for scopes to take effect.
The clipboard Frame's generated resource is built by `npm run build`; build it
before deploying. UI Kit itself is bundled by Forge.

## Capture behavior

- NC requires record type, part number, failure mode, and detected date.
- CAPA requires record type, part number, and failure mode. Closed date and
  effectiveness evidence link appear only for CAPA and are optional. Detected
  date is optional for CAPA. Supplied dates must be real `YYYY-MM-DD` dates;
  a supplied evidence link must use HTTP or HTTPS.
- Supplier and line are optional text. Text inputs allow up to 2,000 characters;
  the backend also enforces Jira's 32,768-byte property limit.
- Switching to NC and saving clears the CAPA-only stored values.
- `partOriginal` preserves every character typed. `partNorm` trims, collapses
  whitespace, and uppercases. Revision parsing uses `src/config/partPattern.js`.
  With the default pattern, `" p-4471 -a "` yields `partNorm: "P-4471 -A"`,
  `partBase: "P-4471 "` (including its trailing space), `partRevision: "A"`.
  No punctuation or internal space is silently removed.

All requests use `asUser()`. Resolvers take the issue ID only from
`req.context.extension.issue.id`. Unexpected payload fields, including issue IDs,
are rejected before any API call. HTTP 403/404 responses return no record data.
Jira uses 404 for both a missing property and an inaccessible issue; either
therefore displays an empty form. A failed write never displays success.
Other load failures block editing and offer Retry loading.

## E1 timing probe

Set `E1_PROBE = true` in `src/config/devFlags.js` before building/deploying to
show the probe. The flag also gates its backend resolvers. Default: false.

Click **Run 20 probes** on a test issue you can browse and edit. Each sequential
run writes only `{token}` to `qualityloop-probe`, reads it back, then polls the
enhanced JQL endpoint at one-second intervals without overlapping searches.
The batch has no background execution: closing the panel stops further calls.
The last probe token remains on the issue; starting another batch replaces it.
Avoid concurrent batches on the same issue, since they share that property.

- **Write ms:** resolver time around the property PUT round trip.
- **Readback ok:** whether the property GET returned this run's token.
- **Search-hit ms:** frontend elapsed time since the write acknowledgement,
  including readback, bridge latency, and polling. It is an observed visibility
  measurement, not Jira's internal indexing timestamp. No `reconcileIssues` is
  sent, so search reconciliation cannot mask normal indexing delay.
- The search deadline is 60 seconds after write acknowledgement. A timeout
  becomes `miss`. API/bridge failures become `error`, separately from misses.
  The summary's min/median/max use successful search hits only.
- A live table shows progress. After completion, **Copy results** copies plain
  text containing all tokens, timings, readback values, errors, and the summary.
  UI Kit has no documented clipboard API; a small Forge-hosted Frame provides
  this control through the documented Events bridge. It uses the module
  instance's `localId` to scope events. Browser clipboard denial exposes selected
  text for manual copying. It adds no external egress or OAuth scope.

After measuring, set `E1_PROBE = false`, build, and deploy again.

## Manifest and verified documentation

`app.id` and the native issue-panel wiring are unchanged. One
`jira:entityPropertySet` indexes both issue properties:

| Property | Field | Type | Search alias |
| --- | --- | --- | --- |
| qualityloop | recordType | string | qlRecordType |
| qualityloop | partNorm | string | qlPart |
| qualityloop | partBase | string | qlPartBase |
| qualityloop | failureMode | string | qlFailureMode |
| qualityloop | supplier | string | qlSupplier |
| qualityloop | detectedDate | date | qlDetected |
| qualityloop | closedDate | date | qlClosed |
| qualityloop-probe | token | string | qlProbeToken |

Only these scopes are declared:

- `read:jira-work`: GET issue properties and POST enhanced JQL search; also
  required by the property-set module.
- `write:jira-work`: PUT issue properties; also required by the property-set module.

Forge MCP verified the platform, manifest, backend, UI Kit components, Frame,
Events bridge, theme/context bridge methods, property-set indexing syntax,
both issue-property API methods, enhanced JQL request/response, and required
scopes before implementation. Reference pages:

- [Entity property set](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-entity-property-set/)
- [Issue properties REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
- [Issue search REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [UI Kit Form](https://developer.atlassian.com/platform/forge/ui-kit/components/form/)
- [Frame](https://developer.atlassian.com/platform/forge/ui-kit/components/frame/)
- [Events](https://developer.atlassian.com/platform/forge/apis-reference/ui-api-bridge/events/)
- [Custom UI clipboard permissions](https://developer.atlassian.com/platform/forge/custom-ui/iframe/)
- [Major version changes](https://developer.atlassian.com/platform/forge/versions/)

No manifest entries or Jira REST schemas remain unverified. Live Jira rendering,
index visibility, inherited Frame context, and browser clipboard behavior still
require the owner checks below. The MCP HTTP-error diagnosis tool cannot accept
a CLI lint approval; the approval was checked against Forge's versioning docs.

## Owner click/check sequence

1. Open a Jira test issue you can browse and edit. Open **qualityloop** from the
   issue's Apps menu. Confirm the loading state resolves to an empty capture form.
2. Click **Save** with empty fields. Check record type, part number, and failure
   mode messages. Select **NC**, leave detected date blank, and check its message.
3. Enter `" p-4471 -a "` without the quotes, choose **FM-01 Crack**, supplier
   `Supplier E1`, line `Line 1`, and detected date `2026-10-31`. Click **Save**.
   Check the saving state and success message. Reload the issue and reopen the
   panel; confirm the exact part string and all other fields are prefilled.
4. Switch to **CAPA**. Confirm closed date and evidence link appear and detected
   date becomes optional. Try an invalid evidence URL and check its message.
   Save with a closed date and a valid link, reload, and check prefill. Switch
   back to NC, save, then reload as CAPA to confirm CAPA-only saved values cleared.
5. In Jira issue search's advanced JQL editor, run these separately after indexing:
   `qlRecordType = "NC"`, `qlPart = "P-4471 -A"`, `qlPartBase = "P-4471 "`,
   `qlFailureMode = "FM-01"`, `qlSupplier = "Supplier E1"`, and
   `qlDetected = "2026-10-31"`. Restrict to the test issue if needed. After saving
   a CAPA with a closed date, check `qlClosed = "<saved YYYY-MM-DD>"` too.
6. With the dev flag true and deployed, click **Run 20 probes**. Check that the
   live table progresses through exactly 20 sequential rows and readbacks are
   true. Check min/median/max and misses. Click **Copy results**, paste into a
   text editor, and confirm all 20 rows and the summary. If copying is blocked,
   confirm the manual-copy fallback appears. A zero-hit timeout should be `miss`;
   a rejected API request should be `error`.
7. Test with a viewer who can browse but cannot edit the issue. Loading may show
   readable data, but Save must show an error and never success. A viewer who
   cannot browse the issue must receive no saved property data. If supported
   in your test setup, revoke access while the panel is open and retry Save.
8. Disable the dev flag, build/deploy, and confirm the probe is absent.

## Local checks

Jest covers normalization, original-string preservation, date/link validation,
schema construction, context-only issue access, denied reads/writes, bounded JQL,
probe gating, sequential polling, deadlines, cancellation, and result summaries.
`jest.config.cjs` restricts discovery to `src/`; `eval/test/` is never read.
`npm run build` creates the clipboard bundle and compiles app entry points.
Dependency installation reported transitive npm audit findings; unrelated
dependency upgrades are outside T1.
