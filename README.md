# QualityLoop

**Recurrence evidence for nonconformances in Jira: deterministic matching, viewing-user Jira access, and engineer decisions.**

After a successful nonconformance (NC) save in the issue panel, QualityLoop requests a search for corrective actions (CAPAs) using recorded failure fields and closure dates before the NC's detection date. It shows their evidence and records the engineer's decision.

QualityLoop presents possible recurrence evidence rather than declaring that a CAPA failed. Matching and decision recording do not change CAPA status; the optional sample scenario can attempt status transitions on sample CAPAs. The app does not fetch evidence-link contents; opening those links is a separate browser action.

> Built for Codegeist 2026, category **Apps for Specialized Industries**.

## What it does

| Step | What happens |
|---|---|
| **Capture** | An issue panel stores record type (NC or CAPA), part number, failure mode, supplier, line, dates and an effectiveness-evidence link in one issue property (`qualityloop`). |
| **Match** | After a successful NC panel save, Jira is searched *as the viewing user*. Strong matches require the same normalised part number and failure mode, with a recorded QualityLoop closure date 1–365 days before detection; Jira status does not establish closure. An otherwise eligible different revision of the same base part is shown separately as a related revision. |
| **Inspect** | Each card shows the matched fields, closure date, days since closure and whether effectiveness evidence was recorded. Strong and revision cards warn when Jira is outside the Done category. The most recent 25 of each class are displayed, with omitted visible matches disclosed. |
| **Hints** | "Not matched — check these" can show up to three hints from limited searches: near-identical part numbers, CAPAs with no closed date and older precedents, with the same normalised failure mode. These are never treated as matches. |
| **Decide** | The engineer records Engineer-confirmed recurrence, Not a recurrence (with a category) or Effectiveness concern. A follow-up task is created only after a confirmation dialog listing the task, link and intended CAPA assignee. An explicit assignee rejection falls back to unassigned. Interrupted follow-ups offer a search and a separate confirmation to recover a unique task key. |

### Decision states

- **Possible recurrence:** the system shows a match based on recorded fields only.
- **Engineer-confirmed recurrence:** an explicit human decision, with a reason.
- **Not a recurrence:** an explicit human decision, with a category.
- **Effectiveness concern:** allowed when the pair's current state is Engineer-confirmed recurrence, or when the CAPA has no effectiveness-evidence URL. It can create a re-review task after the user confirms the listed writes.

Decision explanations are appended rather than overwritten; follow-up metadata can be updated and cleanup can delete records. This is not an immutable audit trail; no certification claim is made here.

Decision loading uses at most five concurrent CAPA loads and shares issue, user and pair-state reads within each invocation. A legacy confirmation flag is persisted with a version condition when first derived. Follow-up recovery never creates another task; older claims without a recorded claim time require a manual Jira check. The side view still uses **Refresh evidence and decisions** after a panel change because UI Kit cross-module event emission could not be established from the Forge documentation. See [T15](docs/tasks/T15.md) for validation, simulated call counts, production dependency findings and the owner checklist.

## Try it

1. On a Jira Cloud site with QualityLoop already installed, open a project where you can create issues.
2. In the **project navigation → QualityLoop** page, click **Create sample scenario (5 issues)**. Review and confirm the listed writes. Creation can fail or leave a partial scenario; the plan includes a sample link and attempted Done-category transitions on the sample CAPAs.
3. When ready, open the linked new sample NC and click **Save** in its **qualityloop** issue panel, with Edit Issues permission.
4. Review the evidence and any hints, then record a decision. The sample does not guarantee a hint will be shown.

The repository's owner click/check sequence is in [T10.md](docs/tasks/T10.md).

## Architecture

```mermaid
flowchart LR
  P["jira:issuePanel<br/>qualityloop-hello-world-issue-panel"] -->|invoke| R["resolver → index.handler<br/>loadCapture / saveCapture / findMatches / findHints<br/>getPanelAccess / getDecisions / recordDecision"]
  C["jira:issueContext<br/>qualityloop-evidence-context"] -->|read-only invoke| R
  R -->|asUser: read and write issue property| J[(Jira issue properties<br/>qualityloop)]
  R -->|asUser: enhanced JQL on property aliases| S["POST /rest/api/3/search/jql"]
  R -->|pure functions| L["normalise / matchCaptures / selectHints"]
  R -->|commitDecision: versioned transaction| K[("Forge Custom Entity Store<br/>decision / pair-state")]
  P -->|invoke after concern; create only after confirmation| T["prepareConcernTask / createConcernTask<br/>index.handler"]
  T -->|asUser| F["POST /rest/api/3/issue<br/>POST /rest/api/3/issueLink"]
  T -->|claimTask / saveTaskMetadata| K
  D["trigger: qualityloop-issue-deleted<br/>issue deleted / project permanently deleted → index.onIssueDeleted"] -->|best-effort storage cleanup| K
  A["jira:projectPage<br/>qualityloop-samples"] -->|invoke| B["sample-resolver → index.sampleHandler<br/>prepareSample / startSample / advanceSample"]
  B -->|asUser: confirmed sample creation with properties| J
  AP["jira:adminPage<br/>qualityloop-data"] -->|invoke| AR["data-resolver → index.adminHandler<br/>Data health / accessible index repair / sample links"]
  AR -->|visible-record backfill| K
```

- **Modules:** `jira:issuePanel`, `jira:issueContext`, `jira:projectPage`, `jira:adminPage`, `jira:entityPropertySet` (aliases `qlRecordType`, `qlPart`, `qlPartBase`, `qlFailureMode`, `qlSupplier`, `qlDetected`, `qlClosed`), and one deletion trigger subscribed to issue deletion and permanent project deletion. Project trash is not subscribed.
- **Scopes:** `read:jira-work`, `write:jira-work`, `storage:app`, `read:jira-user`.
- **Hosting configuration:** no external egress permission or LLM dependency is declared. Runs on Atlassian eligibility has not been verified here.

## Permissions model

- User-facing Jira reads and writes use `asUser()`. Forge app-storage accesses are guarded by resolver permission checks.
- The current issue ID comes from the resolver context, never from the frontend. Payload CAPA issue IDs are fetched as the user before stored pair/decision data is used; unexpected current-issue IDs are rejected.
- Before returning candidate, history or count data, resolvers fetch the referenced issues as the user and omit denied or missing issues.
- Users who can browse the issue but lack Edit Issues permission get a read-only panel.
- A versioned transaction rejects a stale decision save; on a conflict, the panel requests refreshed state/history rather than overwriting it.

## Matching rules

1. Normalisation trims whitespace, collapses inner whitespace and converts to uppercase. Part numbers additionally follow the named rule **spaces around hyphens are removed**: `SM-6604 -A` and `SM-6604-A` are equal after normalisation. This is deterministic formatting normalisation, not fuzzy matching; failure-mode text normalisation is unchanged. `partOriginal` preserves the input part number, and cards use it for display.
2. The current revision pattern is a trailing `-<1–2 letters>` suffix of the normalised part. An otherwise eligible different revision of the same base part, with the same failure mode, is a **related revision**, never an exact match.
3. A strong or related-revision match needs a recorded QualityLoop closed date between 1 and 365 days before the NC's detection date. Jira status is not a matching gate.
4. Supplier and line do not affect strong or related-revision matches. Supplier can affect **Other related records**; line supplies supporting facts.
5. Strong and related-revision matching use no fuzzy comparisons. Limited, labelled hints can surface some part-number typos; they do not cover every typo.

Existing stored CAPAs keep their old `partNorm` and `partBase` until re-saved; the matcher re-normalises `partOriginal` in memory once a record is fetched, but JQL on `qlPartBase` can still miss older records saved with a trailing-space base, so open and re-save affected CAPAs to refresh those stored fields.

## Evaluation

The evaluation lives in [`eval/`](eval/README.md). The local dev run uses 24 CAPAs and 18 NCs. Dataset documentation describes synthetic data from a fictional plant, 60 NCs in total (including 42 held-out cases), and mechanism-based labels. Held-out contents and results were not inspected here.

- `eval/FROZEN.json` records a freeze date of 2026-11-01 and SHA-256 hashes. The scorer verifies the selected split's inputs and shared corpus against those hashes. The repository snapshot does not establish the historical order of freezing, harness development or test-split custody.
- The scorer in `eval/reference/score.js` shares no code with the app.

| Metric | Dev (18 NCs) | Test (42 NCs) |
|---|---|---|
| Signature correctness (L1) | 18/18 | TODO |
| Pair recall | 0.875 | TODO |
| Recall including hints | 0.938 | TODO |
| Pair precision | 0.737 | TODO |
| Review cards per NC (avg / max) | 1.11 / 2 | TODO |

These are synthetic pure-logic harness results, not live Jira or field performance. The scorer prints every missed TRUE pair with its dataset trap category.

To run the evaluation:

```
npm run eval:dev
```

## Data and privacy

New capture and decision evidence links must use HTTPS, with a hostname, no credentials, no surrounding spaces or control characters, and at most 2,000 characters. Invalid entries show **Use an https:// link.** Stored valid HTTPS links remain clickable; legacy HTTP links remain visible as plain text with **Not a secure link (http)**. Malformed or credentialed stored URLs show **Invalid evidence link** and are never clickable. Editing a CAPA with an old HTTP link keeps that value in the form and requires the engineer to correct it before saving; the app does not silently drop, rewrite or migrate links.

QualityLoop stores QualityLoop fields in Jira issue properties, and decisions in Forge app storage. Opening an evidence link is a separate browser action. Whole-project data is removed following permanent project deletion when cleanup checks succeed, or through confirmed admin Data health removal. **Trashed projects keep their QualityLoop data**, including after restoration. The soft-delete subscription is removed and queued soft-delete events are ignored. Individual issue deletion and confirmed sample removal retain their existing cleanup. Permanent-project events carry no child issue IDs and do not emit child issue-deleted events, so the existing cleanup checks stored references globally with an 18-second read budget and the trash protection below.

Jira admins can open **QualityLoop data → Data health**, click **Check for orphaned records**, then **Remove orphaned records** and confirm the displayed count. The check scans both record entities in ten-record pages, with a 12-second read budget per invocation and at most 20 pages per browser action. Resume controls continue unfinished checks and confirmed removals using account-bound tickets valid for one hour; a page reload, expired ticket, invalid cursor or pre-trash-protection ticket requires a new check. It uses `asApp()` only for issue-existence status, never issue content, and the acting Jira admin's `asUser()` access for the project-trash check. Only counts and app record IDs are returned. Counting or deleting an orphan requires a fresh issue 404 plus reliable exclusion of projects in trash. The result text explains that uncertain records are not counted and are retained. A 403 or other error alone never permits deletion. Existing accessible-record index repair still uses `asUser()`.

Limitations: missing issues cannot be reliably mapped to their project from stored IDs. QualityLoop conservatively retains **all** missing-issue records if any project is in trash or a complete empty-trash result cannot be verified. The project search uses `status=deleted`, meaning the recycle bin. Permanent-event cleanup also verifies the app principal has global `ADMINISTER` before trusting that search; without it, missing records are retained for the admin check. No additional scope or admin permission is granted to the app. These checks are repeated before removal. Event delivery, eventual storage indexes, permissions and budgets can leave records behind; re-run Data health when trash can be excluded. Get issue still requires app Browse projects/issue-security access, so 404 remains an imperfect deletion signal even when trash is excluded. An interrupted progress write after a successful removal may under-report the count, while replay remains safe. No Jira issues are changed by Data health. See [PRIVACY.md](PRIVACY.md) and [T22.md](docs/tasks/T22.md).

## Development

```
npm ci
npm test
npm run eval:dev
forge deploy -e development
forge install -e development --site <site>.atlassian.net --product jira
```

Coding-agent rules are in [AGENTS.md](AGENTS.md).

File-and-line evidence and every README correction are recorded in [T11.md](docs/tasks/T11.md).

Clean-install output, repository hygiene changes and stable dependency recommendations are recorded in [T13.md](docs/tasks/T13.md). Licensed under [MIT](LICENSE).

Bounded evidence loading, current distinct-NC recurrence counts, SIMULATED scale call counts, and the owner-run REAL benchmark instructions are recorded in [T14.md](docs/tasks/T14.md).
