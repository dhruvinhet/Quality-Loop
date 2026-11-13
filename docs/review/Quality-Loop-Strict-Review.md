# Quality-Loop — Strict Codegeist 2026 Review

**For:** Dhruvin Patel (to share with Claude, which will write Codex implementation prompts)  
**Repo:** `/workspace/Quality-Loop` — https://github.com/dhruvinhet/Quality-Loop  
**Snapshot:** `17d0e6c` on `master` (`git pull` on 13 Nov 2026: already up to date). Last commit 3 Nov 2026, 18:55 IST.  
**Reviewer method:** line-by-line read of application source, manifest, eval, tests, and docs; `npm test` (505/505 pass), `npm run lint` (clean), `npm run build` (pass), `npm run eval:dev` (scores identical to README); 35 additional throwaway edge-case tests (not committed, then deleted) that documented several behaviours below.  
**Honesty rule:** nothing here is invented. Items that were not proven on a live Jira/Forge site are marked **needs verification**.

This document is self-contained. Claude has not seen the repo. File paths are relative to the repo root. Line numbers refer to `17d0e6c`.

---

## 0. How to use this document

- Every problem has an ID (`QL-001` …). Use the ID in Codex prompts.
- An **index by severity** is first, then the full write-ups **grouped by category**, each category sorted Critical → Low.
- For each issue: title, severity, category, exact location, what’s wrong (with evidence), why it matters for Codegeist/users, a concrete solution (steps, function names, acceptance criteria, tests), and effort (S hours / M 1–3 days / L 4+ days).
- Feature/strategy work (Rovo, dashboard, Marketplace, etc.) is in **§3**, with implementation-level specs.
- Submission checklist is **§4**. A 40-day phased plan is **§5**.
- Strengths are in **§1.3**. Do not “fix” things that are deliberately conservative (no silent fuzzy matching, no auto-declaration that a CAPA failed, `asUser()` for anything shown to a user) unless a later section explicitly says to change them.

**Codegeist 2026 context (brief):** Specialized Industries category. Deadline **Wed 23 Dec 2026, 1:30 AM IST**. Five criteria at 20% each: Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation. Required: public YouTube demo under 5 minutes, Forge installation share link, English judge instructions. Theme: “AI can think. But knowing what to do takes context.” AI/Rovo is **not** required for a category prize (Forge + Jira is enough) but is this year’s marketing and all four bonus tracks except Marketplace. Last year’s Specialized 1st and 2nd also won Best Rovo Apps; 3rd (Compliant Workflows) was a careful non-Rovo domain app. A different 2025 entry is already named “Quality Loop.”

---

## 1. Project summary and architecture

### 1.1 What it is

QualityLoop is an Atlassian Forge app for Jira Cloud (Codegeist 2026, category Apps for Specialized Industries). After a quality engineer saves nonconformance (NC) details on an issue, the app searches for already-closed corrective actions (CAPAs) with the same failure signature, shows evidence, and records a **human** decision (Engineer-confirmed recurrence / Not a recurrence / Effectiveness concern). It never claims a CAPA failed, does not change CAPA status (except optional Done-category transitions on **sample** CAPAs), and uses **no AI and no external egress**. Matching is deterministic.

That “no AI” choice is product-correct for regulated manufacturing. It is also a judging risk unless the pitch frames the app as using the *right* context (prior CAPA evidence in Jira) rather than as ignoring the 2026 brief.

### 1.2 Architecture and file map

**Platform:** Forge UI Kit (`render: native`), Node 24, React 18. Dependencies: `@forge/react` 12.4.0, `@forge/bridge` 7.2.1, `@forge/resolver` 2.0.2, `@forge/api` 8.4.0, `@forge/kvs` 2.1.1. MIT, v1.0.0. ~3,314 application JS/JSX LOC, ~3,571 test LOC, 25 commits (31 Oct–3 Nov 2026).

**Forge modules** (`manifest.yml`):

| Module | Key / handler | UI | Role |
|---|---|---|---|
| `jira:issuePanel` | key **`qualityloop-issue-panel`** (renamed in T28; baseline used a scaffold key), `index.handler` | `src/frontend/index.jsx` | Capture form, evidence, decisions |
| `jira:issueContext` | `qualityloop-evidence-context`, same resolver | `src/frontend/issueContext.jsx` | Read-only side view |
| `jira:projectPage` | `qualityloop-samples`, `index.sampleHandler` | `src/frontend/projectPage.jsx` | 5-issue DEMO sample |
| `jira:adminPage` | `qualityloop-data`, `index.adminHandler`, `isAdmin: true` | `src/frontend/adminPage.jsx` | Getting started, Data health, index repair |
| `jira:entityPropertySet` | aliases `qlRecordType`, `qlPart`, `qlPartBase`, `qlFailureMode`, `qlSupplier`, `qlDetected`, `qlClosed` | — | JQL on issue property `qualityloop` |
| trigger | `avi:jira:deleted:issue` and `avi:jira:deleted:project` | `index.onIssueDeleted` | Best-effort storage cleanup. **Project trash is not subscribed.** |

**Scopes:** `read:jira-work`, `write:jira-work`, `read:jira-user`, `storage:app`. No egress. Runtime `nodejs24.x`, 256 MB, arm64.

**Data:**

1. Jira issue property `qualityloop` (schema v2): record type, `partOriginal` / `partNorm` / `partBase` / `partRevision`, failure mode, supplier, line, dates, root cause, actions, effectiveness URL, `updatedAt`.
2. Forge Custom Entity Store:
   - `pair-state` — per CAPA+NC: `version`, `state`, `confirmed`, `latestDecisionId`. Indexes `by-issue`, `by-capa`. **No `projectId` attribute or index.**
   - `decision` — append-only decisions plus follow-up metadata (`taskKey`, `taskClaimId`, opaque `taskMarkerToken`, `taskLinkedAt`). Same indexes.
3. Ordinary KVS: `sample:<projectId>`, one-hour account-bound tickets, short-lived locks, Data health batches.

**Data flow:** Panel `saveCapture` (context issue id, never from the frontend) → `loadEvidence` / `findHints` run enhanced JQL **as the viewing user** → every candidate is **re-fetched** with a direct issue GET and classified by pure functions in `src/lib/` → `recordDecision` re-authorises the CAPA, requires it still to be a strong or related-revision match, commits a **versioned KVS transaction** → optional follow-up Task only after a confirmation dialog (`claimTask` prevents duplicates).

**Matching rules** (`src/lib/match.js`, `src/lib/normalise.js`, `src/config/`):

- Normalise: trim, collapse inner whitespace, uppercase. Keep original for display.
- Revision: `/^(.+)-([A-Z]{1,2})$/` on the normalised part only (e.g. `P-100-AA`).
- **Strong:** same `partNorm` + same normalised failure mode + QualityLoop `closedDate` **1–365 days** before NC `detectedDate`. Jira status is a warning, not a gate.
- **Related revision:** same base, different revision, same mode, same window. Never “exact.”
- **Other related:** same part / different mode, or same mode + same supplier + different base. Inspect only; no decisions.
- Hints (max 3, never matches): near-identical part (Damerau-Levenshtein ≤ 1 after stripping spaces and hyphens), same part with no closed date, same part closed before the window.

**Main files:**

```
src/index.js                     exports four Forge handlers
src/config/                      failureModes.js (8 hard-coded FMs), partPattern.js, matching.js (365), devFlags.js (all false)
src/lib/capture.js               validateCapture, buildCapture, validDate
src/lib/normalise.js             part normalisation
src/lib/match.js / matchJql.js   pure matcher + match JQL
src/lib/hints.js / hintJql.js    hint selection + hint JQL
src/lib/decisions.js             types, validation, state machine, concernAllowed
src/lib/followup.js              marker v2, recovery JQL, confirmation copy
src/lib/cleanup.js               orphan classification
src/lib/sampleScenario.js        five DEMO definitions
src/resolvers/index.js           load/save capture, findHints
src/resolvers/evidence.js        findMatches (15s budget, 200-candidate cap, 25 display)
src/resolvers/decisions.js       recordDecision + follow-up create/recover/repair (~453 lines)
src/resolvers/decisionStore.js   KVS transactions, claims
src/resolvers/samples.js         confirmed sample create/remove
src/resolvers/admin.js           Data health + accessible scan
src/resolvers/cleanupStore.js    deletion trigger
src/resolvers/dataHealthStore.js paginated orphan scan/remove
src/resolvers/loadBudget.js      15s (12s health, 18s cleanup) read budget
src/frontend/*                   panel, form, evidence, decisions, sample, admin
eval/                            frozen synthetic set + independent scorer
docs/tasks/                      T2–T22 design notes (high quality)
```

**What was verified this session:** 25 Jest suites, 505 tests, all passed (1.25s). Lint clean. Build import-check passed. Eval: L1 18/18, L2 pair recall 0.813 (target was ≥ 0.95), recall with hints 0.938, precision 0.722, avg 1.056 cards/NC. Live Forge/Jira was **not** exercised (`AGENTS.md` forbids `forge login/deploy`). Held-out 42-NC split is **not in the repo**.

### 1.3 Strengths (do not regress)

Treat these as constraints in Codex prompts:

1. **Permissions model is excellent.** `asUser()` for anything shown to a user; current issue id from resolver context; payload IDs re-fetched as the user; unbrowsable issues omitted from results and counts; confirmation dialogs for writes to other issues; account-bound expiring tickets; opaque v2 follow-up markers; display names only (no account IDs in the UI); operation-only `console.error` (no exception bodies).
2. **Decision concurrency is real.** Versioned KVS transactions, conflict → reload, not overwrite. Follow-up `claimTask` prevents double-create. Recovery never creates another task.
3. **Honesty.** The app never declares CAPA failure. Eval write-up admits synthetic data, AI-assisted labels, and missed pairs. Data health is conservative about Jira 404 vs trash.
4. **Test density** is unusual for a hackathon (more test lines than app code), including simulated scale and load-speed tests.
5. **No hard-coded secrets.** Benchmark script uses env vars and requires `--execute`.

---

## 2. Issue index (by severity)

| ID | Sev | Category | Title | Effort |
|---|---|---|---|---|
| QL-001 | Critical | Submission | Required Devpost artifacts are missing (video, install link, judge instructions, screenshots) | M |
| QL-002 | High | Correctness | CAPA closed date is optional on the form, but matching requires it — silent recall death | S |
| QL-003 | High | Product | Failure modes are 8 hard-coded codes; they disagree with the eval catalogue | M |
| QL-004 | High | Correctness | Spaces around hyphens in part numbers are not normalised (`SM-6604 -A` misses) | S |
| QL-005 | High | Product | Follow-up Task has no description, no reason, and no link to the NC | M |
| QL-006 | High | Security | Capture/UI allow evidence URLs with credentials; decision validation does not | S |
| QL-007 | High | Design | Hints are collapsed by default; judges will miss them | S |
| QL-008 | High | Correctness | Record type can be changed after save, wiping fields and orphaning decisions | S |
| QL-009 | High | Product | Revision pattern only recognises `-<1–2 letters>`; real plant schemes are ignored | M |
| QL-010 | High | Scale | First hint JQL fetches all CAPAs in 365 days, capped at 50 — typos will be missed | M |
| QL-011 | High | Product | Match JQL is site-wide with no project-scope option | M |
| QL-012 | High | Submission | Name clash with a 2025 Codegeist project also called “Quality Loop” | S |
| QL-013 | High | Design | Scaffold module key and default Atlassian icon (panel now `qualityloop-issue-panel`) | S |
| QL-014 | High | Submission | No theme-framed pitch; “no AI” will be scored as ignoring the 2026 brief if left raw | M |
| QL-015 | Medium | Correctness | Match JQL uses `qlClosed <= detectedDate`; matcher requires `<` — same-day rows waste the 200 cap | S |
| QL-016 | Medium | Correctness | Supplier and line are compared raw (case/space sensitive); failure mode is normalised | S |
| QL-017 | Medium | Correctness | Match JQL uses raw `failureMode`; matcher uses `normaliseText` | S |
| QL-018 | Medium | Data | `saveCapture` has no optimistic concurrency and stores no author | M |
| QL-019 | Medium | Dates | Sample “today” and decision-history dates use UTC, not the viewer’s calendar date | S |
| QL-020 | Medium | Demo | Sample scenario can fail or stay “not ready” (custom fields, indexing, `IS NOT EMPTY`) | M |
| QL-021 | Medium | Product | Follow-up requires an issue type literally named `Task` and a Relates link type | S |
| QL-022 | Medium | Design | Side view cannot auto-refresh after a panel change | M |
| QL-023 | Medium | Scale | 15s budget, 200-candidate / 25-card caps, Data health 20 pages — incomplete on large sites | M |
| QL-024 | Medium | Scale | `loadEvidence` and `findHints` do independent full Jira searches | M |
| QL-025 | Medium | Eval | L2 recall 0.813 below own 0.95 target; held-out split TODO; labels not independently reviewed | M |
| QL-026 | Medium | Tests | No CI; gaps on supplier case, capture credential URLs, JQL/matcher same-day, record-type change | S |
| QL-027 | Medium | Docs | Stale AGENTS.md (“storage built later”), unverified “Runs on Atlassian”, wrong `package.json` main | S |
| QL-028 | Medium | A11y / i18n | English-only UI; DatePicker locked to `en-CA`; limited explicit accessibility | M |
| QL-029 | Medium | Security | `http://` evidence URLs are allowed (not HTTPS-only) | S |
| QL-030 | Medium | Hygiene | `npm audit` reports many transitive Forge/Atlaskit vulns (triaged 3 Nov as unreachable) | S |
| QL-031 | Medium | Privacy | Trashed projects keep QualityLoop data (documented); capture records have no actor | — (policy) |
| QL-032 | Medium | Product | Effectiveness evidence is a URL only — no attachment; many plants use PDFs | M |
| QL-033 | Medium | Architecture | `pair-state` has no `projectId` index, so a project dashboard cannot query by project | M (with §3) |
| QL-034 | Medium | Reliability | `pairConfirmed` recursion is unbounded; `Promise.race` budget can leave in-flight requests | S |
| QL-035 | Medium | Design | Hint UI copy is inaccurate (“50 recently closed CAPAs”); Getting Started lives only on the admin page | S |
| QL-036 | Low | Hygiene | ESLint is hooks-only; no TypeScript; no `engines` field | S |
| QL-037 | Low | Correctness | Lookalike Unicode in part numbers will not match (by design, but undiscussed) | S |
| QL-038 | Low | Design | No README screenshot; default panel icon already in QL-013 | S |
| QL-039 | Low | Reliability | React StrictMode may double-invoke loads in dev; follow-up is protected, capture load is just extra calls | S |
| QL-040 | Low | Docs | Privacy contact is a personal Gmail; Marketplace will want a proper policy URL | S |

**Counts:** Critical 1 · High 13 · Medium 21 · Low 5 · **Total 40.**  
(Feature/strategy work in §3 is **not** double-counted here, except where a current code defect blocks it, e.g. QL-033.)

---


## 2.1 Submission and judging readiness

### QL-001 — Required Devpost artifacts are missing

- **Severity:** Critical  
- **Category:** Submission  
- **Location:** Entire repo and Devpost (2026 gallery unpublished; no video, share link, or judge runbook in the repository). Official rules: https://codegeist2026.devpost.com/rules  
- **What’s wrong:** Codegeist 2026 requires, for an eligible submission: (1) a public YouTube demonstration under 5 minutes that shows the project functioning; (2) a Forge **installation share link** (Start sharing your app) so judges can install it; (3) detailed English instructions for every configuration step; (4) a text description of how the project meets the technology requirement (Forge + at least one of Jira / Confluence / JSM / Bitbucket / Teamwork Graph / Rovo); (5) a selected category (Specialized Industries) and any bonus tracks. The Project “must be capable of being successfully installed in a judge’s test environment” and “must function as depicted in the video.” None of these artifacts are in the repo. Presentation is 20% of the score. Without them, official rules make the entry ineligible — odds are zero.  
- **Why it matters:** This is the single highest-impact gap. Engineering quality will never be seen.  
- **Solution:**
  1. Create a Forge share/install link from a **development environment that matches the committed `manifest.yml`** (`forge deploy` + share, owner-run; agents must not collect tokens).
  2. Write `docs/JUDGE-INSTRUCTIONS.md` (English): create/open a project with Create Issues + Edit Issues; open Project → QualityLoop; create sample (confirm the listed writes); wait for readiness (or click Check sample readiness); open the linked DEMO new NC; open the QualityLoop issue panel (apps icon under the title if needed); click Save; review evidence; record a decision; optionally confirm the follow-up task. State required Jira types: standard **Task** issue type and **Relates** link type. State that sample part numbers use the `DEMO-` prefix. Include a troubleshooting section (partial sample, indexing delay, missing Task type).
  3. Record a <5 minute YouTube video (script outline in §4). It must be a live screen recording of the installed app, not slides only.
  4. Capture 4–6 screenshots for the Devpost gallery and README (panel with a strong match, decision modal, follow-up confirmation, sample page, Data health).
  5. Dry-run: install from the share link on a **fresh** Jira site (the provisioned Codegeist demo site is ideal) following only the written instructions. If it fails, it fails for judges.
- **Acceptance:** A stranger can install and complete capture → match → decision → optional follow-up in under 10 minutes using only the instructions. Video shows that same path end-to-end in under 5 minutes and is public. Devpost form is complete.
- **Tests:** Not a unit-test item. Add a manual “owner checklist” at the top of `docs/JUDGE-INSTRUCTIONS.md`. Optionally a script that asserts the judge doc contains the required headings and the sample’s five issue names.
- **Effort:** M (the recording and dry-run, not the writing).

### QL-012 — Name clash with a 2025 Codegeist “Quality Loop”

- **Severity:** High  
- **Category:** Submission  
- **Location:** Repo name `Quality-Loop`, UI title “QualityLoop” (`manifest.yml` titles); colliding project: https://devpost.com/software/quality-loop — Ketan Saraf, Codegeist 2025, hospitality audit platform with a Rovo agent.  
- **What’s wrong:** Judges who sat 2025, or who search Devpost, will hit a different product with the same name. Innovation/Presentation scores suffer from confusion. Marketplace listing under the same name will also collide.  
- **Why it matters:** Presentation and Innovation are 20% each. A confused judge will not re-read carefully.  
- **Solution:** Pick a distinct **submission and Marketplace name** (examples to consider, not mandated: “Recurrence Evidence for Jira”, “CAPA Recurrence Loop”, “QualityLoop NC/CAPA”). Keep the npm/Forge app key stable if needed, but change visible `title` / `label` in `manifest.yml` and all user-facing copy. On Devpost, first paragraph: “This is a manufacturing NC/CAPA recurrence-evidence app for Jira. It is not the 2025 hospitality Quality Loop.”  
- **Acceptance:** No user-visible string is exactly “Quality Loop” without a distinguishing qualifier; Devpost description disambiguates in the first 400 characters; README title matches.  
- **Tests:** A simple snapshot or string test of `manifest.yml` titles, if you want.  
- **Effort:** S.

### QL-014 — No theme-framed pitch; raw “no AI” will read as ignoring the brief

- **Severity:** High  
- **Category:** Submission  
- **Location:** `README.md` (opens with “deterministic matching”, “no LLM”); `AGENTS.md`; no Devpost description in-repo. Theme from https://codegeist2026.devpost.com/: “AI can think. But knowing what to do – really knowing – takes context.” Stage One is pass/fail on whether the project **reasonably fits the theme**.  
- **What’s wrong:** The implementation is a strong *context* product (prior CAPA evidence, as-user search, human decision). The current write-up never says that. A judge skimming “no AI, deterministic matcher” during a Rovo-heavy year can fail Stage One or tank Innovation.  
- **Why it matters:** Stage One is pass/fail. Presentation and Innovation are 40% combined.  
- **Solution:** Do **not** add AI matching. Rewrite README “What it does”, Devpost description, and video first 20 seconds to this story, almost verbatim:

  > The context a quality engineer needs, when a new nonconformance arrives, is whether a closed CAPA already addressed this failure. That context already lives in Jira, if anyone recorded it. QualityLoop retrieves it from the engineer’s own recorded fields, as the viewing user, and stops there. It never declares that a CAPA failed. A hallucinated “this CAPA failed” is worse, in a regulated plant, than a miss. The engineer decides; the app keeps the evidence and the audit of that decision.

  Then one sentence on Forge/Jira (technology requirement) and one on Specialized Industries (manufacturing NC/CAPA).  
- **Acceptance:** README, judge instructions, and video script all use the context framing in the first screen/paragraph. No sentence boasts “we refused to use AI” without the safety reason.  
- **Tests:** n/a (copy).  
- **Effort:** S for copy; M if bundled with the video (QL-001).

---

## 2.2 Correctness and matching

### QL-002 — CAPA closed date is optional, but matching requires it

- **Severity:** High  
- **Category:** Correctness  
- **Location:** `src/lib/capture.js` `validateCapture` (lines 35–61): `closedDate` is validated **only if present** for a CAPA, never required. Form: `src/frontend/CaptureForm.jsx` around 106, label is “Closed date” without `*`. Matcher: `src/lib/match.js:28–29` skips any CAPA without `validDate(candidate.closedDate)`. Jira status is explicitly **not** a substitute. Hints can surface “No closed date recorded” only for the **exact** same `partNorm`.  
- **What’s wrong:** A quality engineer who closes a CAPA in Jira (Done) but leaves the QualityLoop closed date empty produces a record that **will never be a strong or related-revision match**. In a real plant this silently destroys recall. The sample happens to set closed dates, so a happy-path demo hides the trap. Throwaway tests confirmed: `validateCapture({ recordType: 'CAPA', partNumber: 'P-1', failureMode: 'FM-01' })` returns **no errors**.  
- **Why it matters:** Impact (the solution doesn’t work if data entry is natural) and Design (the form doesn’t express the real rule). Judges who type their own CAPA will see “no match.”  
- **Solution:**
  1. In `validateCapture`, if `recordType === 'CAPA'` and `!input.closedDate`, set `errors.closedDate = 'Select a closed date for a CAPA. Matching uses this date, not Jira status.'`
  2. Mark the form label `Closed date *`. Add a one-line hint under the field: “Required for recurrence matching. Jira status is not used.”
  3. On CAPA save, if Jira status is in the Done category and closed date is empty, a warning (not a silent ignore) — **needs verification** of how easily the panel can read status at save time (`getIssue` already loads status in other resolvers).
  4. Keep the “no closed date” hint for **legacy** CAPAs already saved without a date. Do not delete that hint path.
- **Acceptance:** New CAPA without `closedDate` is rejected by client and server validation with a clear message. Existing empty-date CAPAs still load and still appear as hints when the part is exact. Unit tests for both. Form shows `*`.  
- **Tests:** Extend `src/lib/__tests__/capture.test.js`. Frontend test that the label includes the required marker.  
- **Effort:** S.

### QL-004 — Spaces around hyphens in part numbers break exact match

- **Severity:** High  
- **Category:** Correctness  
- **Location:** `src/lib/normalise.js:3–4` (`trim`, collapse inner whitespace, uppercase — **does not** remove spaces adjacent to `-`). Eval miss: `eval/dev/labels.json` NC-027 / CAPA-15, trap `capa_format_not_normalisable`, parts `'SM-6604-A'` vs `'SM-6604 -A'`. Throwaway tests documented: `normalise('SM-6604 -A').partNorm === 'SM-6604 -A'`, and **`partBase` is `'SM-6604 '` (trailing space)**. Hints catch it via `compactPart` (strips spaces and hyphens) + Damerau, but only as a hint, and only if that CAPA falls inside the 50-row hint page (QL-010).  
- **What’s wrong:** This is a realistic data-entry difference. It cost a labelled-true pair on the frozen dev set. The trailing-space `partBase` also poisons `qlPartBase` JQL for that CAPA.  
- **Why it matters:** Impact and the published eval (recall 0.813). Judges who read `docs/t11-eval-dev.txt` will see this miss.  
- **Solution:** Extend official normalisation with a **named, documented** rule: after existing whitespace collapse, also collapse spaces around hyphens: `partNorm = partNorm.replace(/\s*-\s*/g, '-')`. This is **not** fuzzy matching (no typo slop, no Levenshtein on the strong path). Update `eval/README.md` matching rules (same way T7b updated rules to match pre-registered text — do **not** edit frozen `eval/dev/*` or `eval/corpus/*` or `FROZEN.json`). After the rule change, `npm run eval:dev` should still report L1 18/18 against the **updated written rules**, and L2 pair recall should rise because NC-027/CAPA-15 becomes a strong match (13/16 → 14/16 ≈ 0.875, **verify by running**). Record the rule change in `eval/DISPUTES.md`. Update any tests that snapshot `SM-6604 -A` as a hint-only case (`src/frontend/__tests__/hintResults.test.js`, `src/lib/__tests__/hints.test.js`).  
- **Acceptance:** `normalise('SM-6604 -A')` equals `normalise('SM-6604-A')` (same `partNorm` and `partBase` `'SM-6604'`, revision `'A'`). Cases: `'SM-6604- A'`, `' SM-6604 - A '`, already-clean `'SM-6604-A'`. Strong match, not merely a hint. Eval L1 still 18/18. Frozen files unchanged.  
- **Tests:** `src/lib/__tests__/normalise.test.js` and `match.test.js`. Re-run `npm run eval:dev`.  
- **Effort:** S.

### QL-008 — Record type remains editable after save

- **Severity:** High  
- **Category:** Correctness  
- **Location:** `src/frontend/CaptureForm.jsx:69` — `<Select ... recordType ... isDisabled={isSubmitting}>` only. Server `saveCapture` will accept a type change. `buildCapture` (`src/lib/capture.js:64–78`) **clears** `closedDate`, `rootCause`, `actionsTaken`, and `effectivenessEvidenceUrl` when the new type is NC. Decisions in KVS remain keyed by issue id.  
- **What’s wrong:** An engineer can turn an NC that already has decisions into a CAPA (or the reverse). Matching stops applying; stored pair-state and history become “historical” on a record that is no longer an NC; CAPA fields are wiped if going to NC. There is no warning.  
- **Why it matters:** Data integrity for a quality app that otherwise is careful about decision versions. Judges exploring the form can do this accidentally.  
- **Solution:** Once a record exists with a `recordType`, **disable** the record-type Select (`isDisabled={isSubmitting || !!record?.recordType}`). Server-side: in `saveCapture`, if a stored record exists and `payload.recordType !== stored.recordType`, return `{ error: 'Record type cannot be changed after the first save. Create a new issue instead.' }`. Optional later: an admin “convert” flow with confirmation — out of scope for the deadline unless easy.  
- **Acceptance:** UI control disabled after first save. Direct `invoke('saveCapture', { recordType: 'CAPA', ... })` on an existing NC is rejected. Unit test on the resolver (see `src/resolvers/__tests__/index.test.js`).  
- **Tests:** Resolver test + a CaptureForm test if you have a renderer pattern (see existing frontend tests).  
- **Effort:** S.

### QL-015 — Match JQL window is broader than the matcher (same-day closures)

- **Severity:** Medium  
- **Category:** Correctness  
- **Location:** `src/lib/matchJql.js:16` — `qlClosed <= ${detectedDate}`. `src/lib/match.js:29` — `candidate.closedDate >= current.detectedDate` is skipped (requires **strictly before**). Throwaway tests confirmed both. Eligibility is 1–365 elapsed days (T7b / `eval/DISPUTES.md`).  
- **What’s wrong:** Same-day closed CAPAs are fetched, then discarded. On a busy part number they consume the 200-candidate cap (`MATCH_CANDIDATE_LIMIT` in `src/resolvers/evidence.js`) and can cause a false `matchesIncomplete`. Displayed matches remain correct.  
- **Why it matters:** Scale correctness, not a visible false-positive. Easy fix.  
- **Solution:** Change `boundedJql` to `qlClosed < ${escapeJqlValue(capture.detectedDate)}` (already the hint JQL style at `hintJql.js:13`). Update the snapshot in `src/lib/__tests__/match.test.js:118`.  
- **Acceptance:** JQL unit test expects `<` not `<=`. Matcher behaviour unchanged. Same-day still not displayed.  
- **Tests:** `match.test.js` JQL snapshot; optional evidence resolver test.  
- **Effort:** S.

### QL-016 — Supplier and line are not normalised; failure mode is

- **Severity:** Medium  
- **Category:** Correctness  
- **Location:** `src/lib/match.js:31–33`:

  ```javascript
  const sameFailureMode = !!failureMode && normaliseText(text(candidate.failureMode)) === failureMode;
  const sameSupplier = !!text(current.supplier).trim() && candidate.supplier === current.supplier;
  const sameLine = !!text(current.line).trim() && candidate.line === current.line;
  ```

  Other-related JQL (`matchJql.js:23`) uses raw `qlSupplier = ${escapeJqlValue(capture.supplier)}`. Throwaway tests: `'Acme'` vs `'ACME'` and `'Acme '` vs `'Acme'` produce **no** `otherRelated` and no “Same supplier” supporting fact. By contrast, `'fm-01'` vs `'FM-01'` **is** a strong match in the matcher.  
- **What’s wrong:** Inconsistent normalisation. Supporting facts and the supplier branch of “other related” miss obvious equivalents.  
- **Why it matters:** Weaker evidence cards; missed other-related rows.  
- **Solution:** Compare `normaliseText(supplier)` and `normaliseText(line)` for **equality and supporting facts**. Display the original strings. For JQL, search with the normalised supplier only if you also **store** a normalised supplier (otherwise JQL will miss stored `'Acme'` when the NC has `'ACME'`). Preferred: add `supplierNorm` (and optionally `lineNorm`) to the capture schema (v3), populate in `buildCapture`, add a property alias `qlSupplierNorm`, and JQL on that. Migrate: on read, if `supplierNorm` is absent, compute it from `supplier` for in-memory compare; JQL will only be complete for records saved after the change — disclose incompleteness already has a pattern in `findMatches`.  
- **Acceptance:** `'Acme'`, `'ACME'`, `' acme '` are the same supplier for supporting facts and other-related. Display keeps original casing. Tests in `match.test.js`. Schema bump documented.  
- **Tests:** `match.test.js`, `capture.test.js`, JQL tests.  
- **Effort:** S for in-memory compare only; M if adding a stored alias (recommended).

### QL-017 — JQL failure-mode clause is raw; matcher normalises

- **Severity:** Medium  
- **Category:** Correctness  
- **Location:** `src/lib/matchJql.js:12` — `qlFailureMode = ${escapeJqlValue(capture.failureMode)}` (raw). `src/lib/match.js:31` uses `normaliseText`. The form only offers exact enum values (`FM-01`, …), so the **happy path is consistent**. Direct property writes or a future importer can store `'fm-01'` and then JQL will not find them while `matchCaptures` would accept them if they were fetched.  
- **Why it matters:** Fragile if QL-003 adds custom / imported modes.  
- **Solution:** Always persist `failureMode` as a normalised code (`normaliseText` or a stable id) in `buildCapture`. JQL and matcher both use that code. If configurable modes are added (QL-003 / §3.2), JQL must use the stored id, not a display label.  
- **Acceptance:** A round-trip of `'fm-01'` (if ever accepted) is stored as `'FM-01'` or rejected. JQL snapshot uses the canonical code.  
- **Tests:** `capture.test.js`, `match.test.js`.  
- **Effort:** S.

### QL-019 — “Today” and history dates are UTC, not the viewer’s calendar

- **Severity:** Medium  
- **Category:** Dates  
- **Location:** `src/lib/sampleScenario.js:10` — `today = new Date().toISOString().slice(0, 10)` (UTC). `src/frontend/DecisionDetails.jsx:151` — `item.createdAt.slice(0, 10)` (UTC). Matcher windows use `${date}T00:00:00Z` consistently (`match.js`, `validDate` in `capture.js:30–32`). DatePicker: `locale="en-CA"`, `dateFormat="YYYY-MM-DD"` (`CaptureForm.jsx:95,106`).  
- **What’s wrong:** A user in Asia/Calcutta at 1:00 AM on 1 Jan has UTC still 31 Dec 19:30. The sample “DEMO new NC” “detected today” is yesterday. Decision history can show the previous UTC date. Matching itself is internally consistent in UTC date-only fields, which is fine if the DatePicker stores the **calendar** date the user picked (typical) — **needs verification** on live Forge DatePicker (does it ever shift a picked date by timezone?).  
- **Why it matters:** Demo sample dates can look “off.” History dates can confuse.  
- **Solution:** For sample `today`, pass a date from the frontend (`new Date()` in local TZ formatted YYYY-MM-DD) as an optional argument to `prepareSample` / `sampleDefinitions`, validated with `validDate`. For history, format `createdAt` in a stated zone or show the full ISO timestamp with time. Document that stored detection/closure dates are calendar dates, not instants. Verify DatePicker behaviour on a live site and record the result in the task notes.  
- **Acceptance:** Sample “today” equals the creator’s local calendar date. History does not display a UTC-shifted date as a bare YYYY-MM-DD without explanation.  
- **Tests:** `sampleScenario.test.js` with an injected `today`. Frontend format helper unit test.  
- **Effort:** S.

### QL-037 — Unicode lookalike part numbers

- **Severity:** Low  
- **Category:** Correctness  
- **Location:** `src/lib/normalise.js` — no Unicode folding. Latin `A` vs Cyrillic `А` will not match and will usually not hint (`compactPart` only strips spaces and ASCII hyphens).  
- **What’s wrong:** Unlikely in honest plant data; possible in copy-paste from PDFs. Not a current bug so much as an undiscussed limit.  
- **Why it matters:** Low. Do not silently fold scripts (that would violate conservative matching).  
- **Solution:** Document in README matching rules. Optional: if `partOriginal` contains non-ASCII letters, show a form warning “This part number contains non-Latin characters. Matching is exact after trim/case.” Do not auto-convert.  
- **Acceptance:** README mentions the limit. Optional warning is tested.  
- **Tests:** Optional `normalise.test.js` documenting non-equality.  
- **Effort:** S.

---


## 2.3 Security and permissions

The permission model is a strength (see §1.3). The issues below are real inconsistencies or residual risks, not a rewrite of that model. Do **not** switch user-facing reads to `asApp()`.

### QL-006 — Capture and UI allow credentialed evidence URLs; decisions do not

- **Severity:** High  
- **Category:** Security  
- **Location:**
  - Decisions (strict): `src/lib/decisions.js` `validEvidenceUrl` (lines 21–27) rejects `url.username` or `url.password`. Tested in `src/lib/__tests__/decisions.test.js:17–21`.
  - Capture (loose): `src/lib/capture.js:53–59` only checks that `new URL(url).protocol` is `http:` or `https:`.
  - UI (loose): `src/frontend/EvidenceResults.jsx:5–7`:

    ```javascript
    function evidenceUrl(value) {
      try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; } catch { return null; }
    }
    ```

    Then `EvidenceResults.jsx:33` renders `<Link href={url} openNewTab>`. Throwaway tests: `validateCapture` **accepts** `https://user:pass@evil.com/x` (`errors.effectivenessEvidenceUrl` is undefined).  
- **What’s wrong:** An effectiveness-evidence link can carry embedded credentials, be stored on the issue property (visible to anyone who can browse the issue, and to QualityLoop viewers), and be offered as a clickable link. Decision evidence links cannot. This is an inconsistent security bar.  
- **Why it matters:** Security review by judges (especially Runs-on-Atlassian / Marketplace reviewers). Credential leak via issue property.  
- **Solution:** Use **one** shared `validEvidenceUrl` (from `src/lib/decisions.js`, or a tiny `src/lib/urls.js` both import) in `validateCapture`, `evidenceUrl` in `EvidenceResults.jsx`, and `ReadOnlyCapture.jsx`. Reject credentials, leading/trailing space, missing hostname, non-http(s), and control characters. Optionally also reject `http:` (see QL-029) in the same change.  
- **Acceptance:** `https://user:pass@example.com/x` is rejected by capture validation and is **not** rendered as a link (show “invalid evidence link” instead). Existing unit tests for decisions still pass. New capture and frontend tests.  
- **Tests:** `capture.test.js`; frontend test on `evidenceUrl` if extracted.  
- **Effort:** S.

### QL-029 — `http://` evidence URLs are allowed

- **Severity:** Medium  
- **Category:** Security  
- **Location:** Same functions as QL-006 (`validEvidenceUrl` allows `http:`; capture and UI too).  
- **What’s wrong:** Mixed-content or cleartext links from a Jira Cloud HTTPS context. Plants sometimes only have an internal HTTP file server — a real tradeoff.  
- **Why it matters:** Marketplace / security questionnaire.  
- **Solution:** Prefer HTTPS-only with a clear error: “Use an https:// link.” If HTTP must remain, show a warning on the card, not silence. Document the choice. Combine with QL-006.  
- **Acceptance:** Either HTTP is rejected with a clear message, or a visible warning is shown and the README says why HTTP remains. Tests for both the chosen policy and rejection of `javascript:` (already rejected).  
- **Tests:** `decisions.test.js`, `capture.test.js`.  
- **Effort:** S.

### QL-030 — Transitive npm audit findings

- **Severity:** Medium (process; runtime reachability was already analysed)  
- **Category:** Hygiene  
- **Location:** `docs/SECURITY-DEPENDENCIES.md` (3 Nov 2026). This session’s `npm ci` reported 35 vulnerabilities in the **full** tree (1 low, 21 moderate, 13 high). The T19 note reports 14 production entries, 7 advisory IDs, leaves `glob`, `minimatch`, `markdown-it`, `prosemirror-view`, and concludes they are **absent from the five app entry graphs**. Authors refused untested SDK overrides.  
- **What’s wrong:** A judge running `npm audit` will see red. The write-up is good but dated and was not re-run here end-to-end (`scripts/audit-dependency-paths.js` was not re-executed this session).  
- **Why it matters:** Marketplace bonus and security-conscious judges.  
- **Solution:** Re-run the documented procedure in `docs/SECURITY-DEPENDENCIES.md` after any lockfile change; refresh the date. Do **not** `npm audit fix --force`. If a Forge SDK release has landed fixed ranges, a deliberate, fully tested bump is fine. Mention the triage in the Devpost “what we built” section in one sentence.  
- **Acceptance:** Doc date is current; `node scripts/audit-dependency-paths.js` output saved under ignored `dist/` as before.  
- **Tests:** The audit script itself.  
- **Effort:** S (re-run); M if a careful SDK bump is justified.

---

## 2.4 Product, UX, and design

### QL-003 — Hard-coded failure-mode catalogue, inconsistent with eval

- **Severity:** High  
- **Category:** Product  
- **Location:** `src/config/failureModes.js` (the entire file, 8 entries):

  ```
  FM-01 Crack
  FM-02 Dimension out of tolerance
  FM-03 Surface defect
  FM-04 Porosity
  FM-05 Wrong or missing part
  FM-06 Contamination
  FM-07 Weld defect
  FM-99 Other
  ```

  Eval corpus `eval/corpus/capas.json` `failureModes`:

  ```
  FM-01 Crack
  FM-02 Burr
  FM-03 Dimension out of tolerance
  FM-04 Porosity
  FM-05 Corrosion
  FM-06 Missing feature
  FM-07 Surface damage
  ```

  Matching uses the **code**, so eval L1 is still valid. The **labels** disagree (FM-02, FM-03, FM-05, FM-06, FM-07). There is no admin UI or project setting to change the list. `validateCapture` rejects any code not in the array (`capture.js:32–34`).  
- **What’s wrong:** A real plant cannot use its own FM codes. If the video or README tells eval stories (“burr on the mount”) while the form says FM-02 is “Dimension out of tolerance,” that is a credibility hit.  
- **Why it matters:** Impact (adoption) and Design (complete product). This is also the highest-value **product** change for actual use. Full configurable-FM spec is in §3.2.  
- **Solution (minimum before the deadline, if §3.2 is only partially done):**
  1. Align the **default** catalogue labels with one consistent story (either the eval plant or a documented “generic manufacturing” list). Do not leave two meanings for FM-02.
  2. Prefer implementing §3.2 (per-project configurable modes stored in KVS, with the current list as the default). Even a small admin “edit failure modes for this site” on the QualityLoop project or admin page is enough for judges.
- **Acceptance:** One documented catalogue. Form, cards (`FAILURE_MODES.find` in `EvidenceResults.jsx:18`), validation, sample, and eval **labels** (not frozen codes) tell the same story. Custom codes can be added without a code change if §3.2 is done.  
- **Tests:** Update `failureModes` snapshots; validation tests for custom codes if configurable. **Do not edit frozen eval JSON.** If only labels in the app change, eval is unaffected (it uses codes).  
- **Effort:** S to align labels; M for full configurability (§3.2).

### QL-005 — Follow-up Task is an empty shell

- **Severity:** High  
- **Category:** Product  
- **Location:** `src/resolvers/decisions.js:415–417`:

  ```javascript
  const fields = { project: { id: project.id }, issuetype: { id: taskType.id },
    summary: `Effectiveness re-review: ${capa.key}`,
    assignee: intendedAssignee?.accountId ? { accountId: intendedAssignee.accountId } : null };
  ```

  No `description`. The Relates link (`linkTask`, lines 38–41) is **task ↔ CAPA only**, not the NC. Confirmation copy (`src/lib/decisions.js` `followupConfirmation`, lines 73–78) lists project, summary, intended assignee, and a hidden marker — not a description or an NC link.  
- **What’s wrong:** The CAPA owner receives a Task with a title and no body: no NC key, no engineer reason, no evidence links, no “open QualityLoop on this NC.” In a real workflow this is close to useless. The careful confirmation dialog lists writes that don’t include the information the assignee actually needs.  
- **Why it matters:** Impact and Design — the only write into Jira work management is incomplete. Judges who click the created task will see a hollow issue.  
- **Solution:**
  1. Set `fields.description` as a Jira ADF document containing: decision type (“Effectiveness concern”), NC key and summary (link), CAPA key, the engineer’s `reason` (and category if any), evidence URLs as links, and “Open the QualityLoop panel on {NC key} to see the full history.” ADF shape **needs verification** against current Jira issue-create docs (`fetch-api-operation` / Forge docs) — do not invent ADF. If ADF is awkward, a plain-text `description` / `environment` field only if the API allows; prefer ADF.
  2. After creating the task, also `linkTask` to the **NC** (same Relates type), in addition to the CAPA. Re-read both issues asUser before each write. Update `followupConfirmation` and `repairLinkConfirmation` to list **both** links. Confirmation text must stay in exact string-equality lockstep with `createConcernTask` (the current code compares the confirmation string).
  3. If description or a second link cannot be written (permission, required fields), return a clear “created with limits” message, and still record `taskKey`.
- **Acceptance:** A created follow-up, opened in Jira, shows the reason and the NC key without opening QualityLoop. Issue links include both CAPA and NC. Confirmation dialog text lists every write. Resolver tests in `src/resolvers/__tests__/decisions.test.js` assert `fields.description` and two link calls (mock). Existing claim / assignee-fallback / no-double-create tests still pass.  
- **Tests:** Extend `decisions.test.js` (the 726-line file already mocks create). Unit test confirmation strings in `src/lib/__tests__/decisions.test.js` / `followup.test.js`.  
- **Effort:** M.

### QL-007 — Hints are collapsed by default

- **Severity:** High  
- **Category:** Design  
- **Location:** `src/frontend/HintResults.jsx:4–9` — `useState(false)` for `expanded`; the section is a subtle button “Not matched — check these.” Two of three labelled-true eval misses appear **only** as hints (`docs/t11-eval-dev.txt`: NC-002, NC-027). NC-043 is still missed even as a hint (wrong FM → other-related). Copy at line 16: “checks up to 50 recently closed CAPAs” is also inaccurate (QL-035): three queries, first with no part filter.  
- **What’s wrong:** The most interesting conservative-matcher design (labelled hints, never treated as matches) is invisible unless the user clicks a quiet button. Judges on a timer will not.  
- **Why it matters:** Design and Presentation. The eval story “we miss some true pairs but hint them” only works if hints are seen.  
- **Solution:** If `result.hints.length > 0`, default **expanded** (`useState(() => (result.hints?.length > 0))` — or expand when hints arrive via `useEffect`). Keep the “these are not matches” wording prominent (SectionMessage appearance="information"). If there are zero hints, keep collapsed or hide (current hide-when-not-applicable is fine). Fix the copy (QL-035) in the same change.  
- **Acceptance:** On the sample NC after Save, if any hint exists, it is visible without a click. The “not a match” disclaimer is visible. Frontend tests in `hintResults.test.js` updated.  
- **Tests:** `src/frontend/__tests__/hintResults.test.js`.  
- **Effort:** S.

### QL-009 — Revision pattern is only a trailing `-<1–2 letters>`

- **Severity:** High  
- **Category:** Product  
- **Location:** `src/config/partPattern.js:3` — `export const PART_PATTERN = /^(.+)-([A-Z]{1,2})$/;` Comment at lines 1–2 is clear. Throwaway tests: `P-100-01` (numeric), `P-100-ABC` (three letters), `P-100 Rev A` all have `partRevision === null` and `partBase === partNorm`. They will never be “related revision.”  
- **What’s wrong:** Many automotive/ISO part schemes use numeric revisions or other suffixes. Related-revision is a headline feature that will not fire on real data.  
- **Why it matters:** Impact and Innovation (the feature is narrower than the README implies).  
- **Solution:** Make the pattern **configurable per project** (store a regex or a choice of presets in project KVS, default = current). Presets to offer: (a) current `-<1–2 letters>`, (b) `-<1–3 alphanumeric>`, (c) `-R` + digits, (d) “no revision split.” Show the computed base and revision **live on the capture form** as the user types (“Base: P-100 · Revision: A”) so a wrong pattern is obvious. Do not silently “guess” across patterns on the same site. Document the default in README. Validate the custom regex (must have two groups; reject catastrophic backtracking — use a length cap and a safe-regex check, or only presets for the deadline).  
- **Acceptance:** With preset (b) or a documented custom pattern, `P-100-01` and `P-100-02` are relatedRevision. Default behaviour for `P-100-A` / `P-100-AA` is unchanged. Live preview on the form. Tests for each preset. Invalid custom regex is rejected.  
- **Tests:** `normalise.test.js`, `match.test.js`, a resolver test if stored on the project.  
- **Effort:** M.

### QL-011 — Matching is site-wide; no project scope

- **Severity:** High  
- **Category:** Product  
- **Location:** `src/lib/matchJql.js` `boundedJql` — no `project =` clause. Search is whatever the viewing user can browse **across the site**.  
- **What’s wrong:** Useful for a company with one quality project or shared CAPAs; dangerous on a messy site (unrelated projects, exhausted caps, surprising cards). There is no setting.  
- **Why it matters:** Scale and Design (a complete product lets an admin choose). Judges on a crowded demo site may see noise.  
- **Solution:** Add a project-page (or admin) setting: “Search CAPAs in: this project only | this project and {list} | all projects I can browse” (default **this project only** for predictable demos; README can explain). Persist in KVS `settings:<projectId>`. Apply `project in (...)` in `buildMatchJql`, `buildOtherRelatedJql`, and hint JQL. Always `escapeJqlValue`. Confirmation is not required (read-only setting for search), but changing the setting should be permission-checked (project admin **needs verification** of which Jira permission to use; at minimum the current user must be able to browse the project). Disclose the scope on the evidence heading (“Searching in this project”).  
- **Acceptance:** Default demo sample only matches DEMO issues in that project, even if another project has `DEMO-4471-A`. A documented switch widens the search. JQL unit tests for all three modes.  
- **Tests:** `matchJql.js` / `hintJql.js` tests; resolver test with mocked setting.  
- **Effort:** M.

### QL-013 — Scaffold issue-panel key and default icon

T28 maintenance note: module-key references in this review and earlier task docs
now use `qualityloop-issue-panel`. The findings below describe the pre-T28
scaffold key and stock icon; current implementation and owner steps are in
`docs/tasks/T28.md`.

- **Severity:** High  
- **Category:** Design  
- **Location:** Baseline `manifest.yml:27` used the scaffold panel key, now `qualityloop-issue-panel`. The baseline `icon:` was the stock Atlassian Forge panel icon and README mermaid named the scaffold key. Changing a **module key** on an already-installed app can break the installed module — **needs verification**; if already installed on the owner’s site, changing the key may require a reinstall or a documented migration.  
- **Why it matters:** First thing a judge sees in the manifest and possibly in the Jira apps list. Looks unfinished (Design, Presentation).  
- **Solution:** Rename to `qualityloop-issue-panel` **if** a clean reinstall is acceptable for all install sites (this is pre-Marketplace; likely yes). Add a simple custom icon (SVG, quality/recurrence motif; not a copy of Atlassian or the 2025 Quality Loop). Update README mermaid, T-docs that cite the key, and any tests that snapshot the key. Follow Forge’s rules for icon size/format (**needs verification** in Forge docs).  
- **Acceptance:** No `hello-world` string in `manifest.yml` or README. Custom icon appears on the panel. App still loads in a fresh install.  
- **Tests:** Grep/CI assertion `!hello-world`.  
- **Effort:** S (plus owner reinstall).

### QL-021 — Follow-up requires a type literally named `Task` and Relates

- **Severity:** Medium  
- **Category:** Product  
- **Location:** `src/resolvers/decisions.js` create path (~392–404): finds `type.name === 'Task' && !type.subtask`. Relates: `getRelatesType` looks for `name?.toLowerCase() === 'relates'`. Sample creation similarly requires Relates (`samples.js`).  
- **What’s wrong:** Team-managed or localised Jira sites, or sites that renamed “Task” to “Item,” cannot create follow-ups. The decision is still stored (good), but the message may feel like a failure.  
- **Why it matters:** Demo on a non-classic project can stall.  
- **Solution:** Prefer Task; otherwise fall back to the first non-subtask standard type from createmeta (sample already uses `selectSampleIssueType`). Put the **chosen type name** in the confirmation dialog. For links, keep Relates if present; if not, explain “Enable the Relates link type, or the task will be created unlinked” and still allow create + Verify later. Document in judge instructions: classic project with Task + Relates is the supported demo.  
- **Acceptance:** On a project whose only standard type is “Story,” follow-up still creates (after confirmation that names “Story”). Tests with mocked createmeta.  
- **Tests:** `decisions.test.js`.  
- **Effort:** S.

### QL-022 — Side view does not auto-refresh

- **Severity:** Medium  
- **Category:** Design  
- **Location:** `README.md` and T15: UI Kit cross-module events could not be established from Forge docs. `src/frontend/issueContext.jsx` + `MatchView.jsx` “Refresh evidence and decisions.”  
- **What’s wrong:** Documented limitation. After recording a decision in the panel, the side view is stale until refresh.  
- **Why it matters:** Design polish. Not a blocker if the video uses the panel only and the side view mentions “click Refresh.”  
- **Solution:** Re-check current Forge UI Kit docs for events (**needs verification**). If still impossible, keep the button, and make the stale-risk explicit in the side-view SectionMessage (“This view does not update live. Click Refresh after changing the panel.”). Do not spend days on this.  
- **Acceptance:** Either live refresh works and is tested, or the copy is explicit.  
- **Tests:** Existing `issueContext.test.js`.  
- **Effort:** S for copy; M if a documented event API now exists.

### QL-032 — Effectiveness evidence is a URL only

- **Severity:** Medium  
- **Category:** Product  
- **Location:** Capture field `effectivenessEvidenceUrl`; the app “does not fetch evidence-link contents” (README, intentional).  
- **What’s wrong:** Plants often attach a PDF to the Jira issue. The app will not see it as effectiveness evidence.  
- **Why it matters:** Impact on real use. For the deadline, a smaller fix is enough: on the CAPA card, if no URL is recorded, also show “This Jira issue has N attachments” (count only, asUser, no file fetch) and a link to the issue. Do not download files (Runs on Atlassian / egress).  
- **Acceptance:** Card shows attachment count when the URL is empty. No file bytes are fetched.  
- **Tests:** Evidence mapper with mocked `fields.attachment`.  
- **Effort:** S–M.

### QL-035 — Hint copy is inaccurate; Getting Started is admin-only

- **Severity:** Medium  
- **Category:** Design  
- **Location:** `HintResults.jsx:16` (“50 recently closed CAPAs” — actually three queries, first is **all** CAPAs in the window). `GettingStarted.jsx` is mounted from `adminPage.jsx` only, not the project page.  
- **What’s wrong:** Misleading completeness text. Judges using the project page (the right starting point) do not see the admin Getting Started steps or sample-NC links. The project page has shorter text, which is OK if complete.  
- **Solution:** Fix hint copy: “Up to three hints, from limited searches (at most 50 candidates each): near-identical part numbers, same part with no closed date, and older precedents. These are not matches.” Add a compact “How to try this” (3 lines + link to the new NC once ready) on `projectPage.jsx`.  
- **Acceptance:** Copy matches behaviour. Project page can complete a first-run without visiting admin.  
- **Tests:** `hintResults.test.js`; project page text test if present.  
- **Effort:** S.

### QL-038 — No README screenshot

- **Severity:** Low  
- **Category:** Design  
- **Location:** T11 removed a broken `docs/panel.png` reference. Still absent.  
- **Solution:** Add screenshots from QL-001 to README and Devpost.  
- **Effort:** S.

---


## 2.5 Scale, performance, and Forge limits

### QL-010 — First hint query is unscoped and capped at 50

- **Severity:** High  
- **Category:** Scale  
- **Location:** `src/lib/hintJql.js:12–15` — first query:

  ```javascript
  `qlRecordType = "CAPA" AND qlClosed >= ${start} AND qlClosed < ${detected} ORDER BY qlClosed DESC, key ASC`
  ```

  No part, no project, no failure mode (comment: stored FM originals may differ in case). `HINT_CANDIDATE_LIMIT = 50` (`hints.js`). `findHints` in `src/resolvers/index.js` fetches one page per query, then GET-hydrates each issue. Truncation sets `truncated: true`.  
- **What’s wrong:** On a site with >50 CAPAs closed in a year, the first query returns the **newest** 50, which are unlikely to include a one-edit typo of *this* part. The near-identical-part hint — the one that caught NC-027 — silently disappears. The UI may say “No hints found in the checked records.”  
- **Why it matters:** The conservative-matcher story depends on hints. At any realistic scale it breaks.  
- **Solution:** Do **not** fetch all CAPAs. For near-typos you cannot do Levenshtein in JQL. Practical approach:
  1. Keep queries 2–3 (same `qlPart`, missing/old close) — these are already targeted.
  2. Replace query 1 with a **bounded family search**: e.g. same `qlFailureMode` (canonical code) + same project scope (QL-011) + closed in window, cap 50, then run `differsByAtMostOneEdit` in memory. Still incomplete for typos that also change the FM, which is acceptable (NC-043 is already in that bucket).
  3. Optionally generate a small set of one-edit `qlPart` variants only if part length is short and variants are alphanumeric — **careful**, this can explode. Prefer (2) for the deadline.
  4. Honest UI: if truncated, say “Hint search did not cover every CAPA on this site.”
- **Acceptance:** A site with 200 unrelated recent CAPAs and one in-window near-typo of the same FM still surfaces that hint (unit-test with a stubbed search that would have buried it under 50 others in the old query). Scale simulated test updated (`src/resolvers/__tests__/scale.simulated.test.js`).  
- **Tests:** `hintJql` unit tests; resolver test with 60 decoys + 1 near-typo.  
- **Effort:** M.

### QL-023 — Caps and budgets make large-site results incomplete

- **Severity:** Medium  
- **Category:** Scale  
- **Location:** `LOAD_BUDGET_MS = 15000` (`loadBudget.js:1`); evidence 200 candidates, 25 display (`evidence.js`); other-related 20; Data health 12s and **20 pages per browser action** (`pageRunner.js` `maxPages = 20`, 10 records/page). Cleanup 18s. Forge function timeout is typically ~25s — **needs verification** against current Forge docs; 15s is a reasonable margin if so. 429/5xx → `JIRA_BUSY`.  
- **What’s wrong:** The app discloses incompleteness (good). On a large plant it will often be incomplete. There is no “continue search” for matches (there is for Data health). Confirmed counts cap at `"50+"`.  
- **Why it matters:** Impact at the scale the README’s honesty already anticipates. Judges on a small sample will not see this.  
- **Solution:** Keep caps (they are correct). Add a “Load more / retry with a fresh budget” on the evidence panel when `matchesIncomplete`, `incomplete`, or `uncheckedCandidates` is true (it already says “Refresh”). Consider raising display from 25 only after measuring UI Kit cost (**needs verification**). For Data health, the resume path already exists — make sure judge/admin docs explain it. Document site-size expectations in README (e.g. “designed for hundreds of CAPAs per year per signature, not unbounded corporate archives”).  
- **Acceptance:** Incomplete flags remain accurate. A user can retry without losing already-rendered cards (MatchView already keeps previous result while `refreshing` — verify this still holds). README has a scale paragraph.  
- **Tests:** Existing scale and load-speed simulated tests must stay green; extend if you add “load more.”  
- **Effort:** M.

### QL-024 — Evidence and hints are two full, independent Jira searches

- **Severity:** Medium  
- **Category:** Scale  
- **Location:** `src/frontend/MatchView.jsx:14` — `Promise.all([invoke('loadEvidence'), invoke('findHints')])`. Two resolver invocations, each with its own 15s budget, each re-reads the current property and runs JQL + GET hydrations.  
- **What’s wrong:** Double load on every refresh; higher 429 risk; slower panel. Architecturally simpler (hints must not enter the match pipeline — a good comment in `index.js`).  
- **Why it matters:** Design (snappiness) on slow sites.  
- **Solution:** Optional: a single `loadEvidenceAndHints` resolver that shares the current-record read and the budget, still keeping hint candidates out of `matchCaptures` / `recordDecision`. Not required if QL-010 shrinks hint JQL.  
- **Acceptance:** One invocation returns both; hint candidates cannot be passed to `recordDecision` (existing test: recordDecision rejects non-matches). Wall time on the simulated load-speed test does not worsen.  
- **Tests:** `loadSpeed.simulated.test.js`, `decisions.test.js` rejection of non-matches.  
- **Effort:** M.

### QL-033 — No `projectId` on pair-state (blocks a cheap dashboard)

- **Severity:** Medium  
- **Category:** Architecture  
- **Location:** `manifest.yml` `pair-state` attributes: `capaId`, `issueId`, `version`, `state`, `confirmed`, `latestDecisionId`, `updatedAt`. Indexes `by-issue`, `by-capa` only.  
- **What’s wrong:** A project-level recurrence dashboard (a high-value feature, §3.3) cannot query “all confirmed pairs in this project” from KVS without a full scan.  
- **Why it matters:** If you implement §3.3, do the schema work first.  
- **Solution:** See §3.3. Short version: either add `projectId` + index (and backfill), or derive the dashboard from JQL of project NCs + `by-issue` lookups (no schema change, asUser-safe, bounded). Prefer the JQL path for the deadline.  
- **Effort:** M with §3.3.

---

## 2.6 Reliability and races

### QL-018 — Capture saves have no version check and no author

- **Severity:** Medium  
- **Category:** Data  
- **Location:** `src/resolvers/index.js` `saveCapture` (lines 122–131) — last PUT wins. `buildCapture` sets `updatedAt` only (`capture.js:76`), no `authorAccountId`. Decisions *do* have versions and authors.  
- **What’s wrong:** Two tabs can overwrite each other without a conflict message. You cannot tell who changed quality fields — a gap in a quality-management app.  
- **Why it matters:** Weaker than the decision path the app is proud of.  
- **Solution:** Add `expectedUpdatedAt` (or a version integer) to `saveCapture`. If the stored `updatedAt` does not match, return `{ conflict: true, record }` and the form reloads (same UX as decisions). Store `authorAccountId` from `context.accountId` (do **not** display the raw id; resolve a display name like decisions).  
- **Acceptance:** Concurrent saves: the second gets a conflict, not a silent overwrite. Tests in `src/resolvers/__tests__/index.test.js`.  
- **Tests:** Resolver tests with a stubbed property that changes between read and write (you may need a GET-before-PUT).  
- **Effort:** M.

### QL-020 — Sample scenario can fail or appear “not ready”

- **Severity:** Medium  
- **Category:** Demo  
- **Location:** `src/resolvers/samples.js` — stepped create, `attempting` flag (no auto-retry after interrupted Jira create), required custom fields can return HTTP 400, transitions may not exist, `sampleReadiness` JQL at line 166 uses `qlClosed IS NOT EMPTY` (and `qlPart`, `qlFailureMode`). `hintJql.js:9–10` notes that `IS EMPTY` is **not documented** for date property aliases. `docs/tasks/T8.md:70` says `qlClosed IS EMPTY` **works** in their trial — **needs verification** on a current Jira site. Frontend polls 30s (`pageRunner.js` `pollSampleReady`).  
- **What’s wrong:** A judge’s first click can produce “partial scenario,” “search was not ready within 30 seconds,” or a hard error. The app is honest, but the first-run impression is poor.  
- **Why it matters:** Presentation. The official “Try it” path is this sample.  
- **Solution:**
  1. Owner: dry-run on a **fresh** Team-managed and a classic company-managed project, including a project with a required custom field. Record results.
  2. If `IS NOT EMPTY` fails, change readiness to: GET the three CAPA issues and check `properties.qualityloop.closedDate` directly (no JQL emptiness operator). JQL can still be used later as a “index is warm” signal, not as the only gate.
  3. After create, if readiness is false, the UI should say “Created. Jira is still indexing. Open DEMO new NC from the list below and click Save anyway; if evidence is empty, wait and Refresh.” Show the five issue links immediately (`sampleStatus` already returns keys).
  4. Judge instructions (QL-001) must include this.
- **Acceptance:** On a clean classic project with Task + Relates and no required custom fields, first-run succeeds. On a project with a required field, the error tells the user to remove the field or use another project — not a generic HTTP code only (today it already includes the status). Readiness is not solely dependent on an undocumented JQL operator.  
- **Tests:** `samples.test.js` for a readiness path that uses direct GETs.  
- **Effort:** M (including owner live checks).

### QL-034 — Unbounded `pairConfirmed` recursion; budget `Promise.race`

- **Severity:** Medium  
- **Category:** Reliability  
- **Location:** `src/resolvers/decisionStore.js:90` — `if (current.version !== pair.version) return pairConfirmed(current, ...)`. `src/resolvers/loadBudget.js:16–22` — `Promise.race` against a timer; in-flight `read()` continues; comments say results are not published. Writes are documented as not raced (Data health).  
- **What’s wrong:** A pathological conflict loop could recurse until the function timeout. In-flight Jira GETs after budget expiry still count against rate limits. Neither is a known production bug; both are residual risks.  
- **Solution:** Add a `depth` argument, max 3, then throw a retryable error. For the budget, leave as-is (correct “don’t publish late reads”) but never wrap **writes** in `budget.run` (already the rule — add a lint comment or a `budget.runWrite` that is not implemented, to prevent future mistakes).  
- **Acceptance:** Unit test that three conflicts do not stack-overflow and return a controlled error. No behaviour change on the happy path.  
- **Tests:** `decisionStore.test.js`.  
- **Effort:** S.

### QL-039 — StrictMode double invoke

- **Severity:** Low  
- **Category:** Reliability  
- **Location:** `src/frontend/index.jsx` and others wrap `ForgeReconciler.render(<React.StrictMode>...)`. `useEffect` loads may run twice in development. Writes use `busyRef` / KVS locks / `FAIL_IF_EXISTS`.  
- **What’s wrong:** Extra reads only, if StrictMode applies in Forge production — **needs verification**. Not a defect if writes stay guarded.  
- **Solution:** Confirm whether Forge production runs StrictMode. If it double-fetches, that is acceptable. Do not remove StrictMode just to hide bugs.  
- **Effort:** S (verify, maybe a comment).

---

## 2.7 Privacy and data lifecycle

### QL-031 — Trashed projects keep data; capture has no actor

- **Severity:** Medium (documented policy, not a silent bug)  
- **Category:** Privacy  
- **Location:** README and `PRIVACY.md`: trashed (restorable) projects keep QualityLoop KVS data. Permanent-delete cleanup is best-effort with trash protection. Capture property has no author (QL-018). Contact in `PRIVACY.md`: `dhruvin1309@gmail.com`.  
- **What’s wrong:** The policy is conservative and explained (good). Judges and Marketplace reviewers will still ask. A personal Gmail as privacy contact looks informal.  
- **Solution:** Keep the trash policy (do not delete on 404). Add a short FAQ in PRIVACY.md and judge instructions. For Marketplace, use a dedicated contact and hosted policy URL (QL-040). Implement capture author as part of QL-018.  
- **Acceptance:** FAQ is visible. No change to trash protection without a new design.  
- **Effort:** S (docs). Policy changes are out of scope.

### QL-040 — Privacy contact is a personal Gmail

- **Severity:** Low  
- **Category:** Docs  
- **Location:** `PRIVACY.md` line 27.  
- **Solution:** For Marketplace, publish PRIVACY.md (or a page) at a stable HTTPS URL and use a mailbox you will actually monitor. Not blocking for Devpost.  
- **Effort:** S.

---

## 2.8 Tests, evaluation, and CI

### QL-025 — Eval methodology and held-out split

- **Severity:** Medium  
- **Category:** Eval  
- **Location:** `eval/README.md`, `eval/FROZEN.json` (hashes include `test/ncs.json` and `test/labels.json` which are **not in the repo**), `docs/t11-eval-dev.txt`, README table Test column all **TODO**. Honesty statement: synthetic plant, labels written with AI assistance, **not** validated by an independent quality engineer. L2 pair recall **0.813** vs stated target **≥ 0.95**. Scorer (`eval/reference/score.js`) shares no code with the app (good). After QL-004, re-run and report.  
- **What’s wrong:** Judges cannot reproduce the 42-case numbers. The headline recall missed its own target (by design of conservative rules, which is fine if explained). FM label mismatch (QL-003) is a presentation landmine if eval stories are used in the video.  
- **Why it matters:** Innovation/Impact evidence is the eval. Incomplete evidence is weaker than honest complete evidence.  
- **Solution:**
  1. Owner runs the held-out split once from the private folder (as eval/README already says). Publish **scores only**, or publish the test files after the run so judges can reproduce (eval/README allows adding them after the final run).
  2. Do not loosen matching just to hit 0.95. After QL-004, report the new recall. Explain the remaining misses (wrong FM, window, mechanism) in the video in 15 seconds — that is a *strength*.
  3. Optional: one quality engineer reviews `eval/dev/labels.json` and records comments in `DISPUTES.md` (the file already invites this). That is high-value Impact evidence.
- **Acceptance:** README Test column is either filled with reproduced numbers or explicitly “not published; harness and hashes are in-repo.” Dev and (if published) test scores regenerate with `npm run eval:dev` / the documented test command. Frozen files still hash-match `FROZEN.json`.  
- **Tests:** `evalPredict.test.js` already exists.  
- **Effort:** M (mostly process and writing).

### QL-026 — No CI; several unit-test gaps

- **Severity:** Medium  
- **Category:** Tests  
- **Location:** No `.github/`. This session’s throwaway tests (deleted after) found QL-002, QL-004, QL-006, QL-015, QL-016, which were **not** covered as named regressions. 505 tests still passed — the suite is strong, not empty.  
- **What’s wrong:** No automation on push. Gaps around the bugs in this review.  
- **Solution:** Add a GitHub Action: `npm ci`, `npm test`, `npm run lint`, `npm run eval:dev`, `npm run build`, and a grep that `hello-world` is absent (after QL-013). Add regression tests listed in each issue above. Do not commit throwaway files under `_throwaway_`.  
- **Acceptance:** A push to GitHub runs the suite green. New tests fail if the bugs are reintroduced.  
- **Tests:** The Action itself.  
- **Effort:** S.

---

## 2.9 Docs, hygiene, accessibility, i18n

### QL-027 — Stale docs and package metadata

- **Severity:** Medium  
- **Category:** Docs  
- **Location:**
  - `AGENTS.md` line 21: “The decision is stored in Forge app storage **(built later)**.” Storage has been implemented since T4.
  - `README.md:63`: “Runs on Atlassian eligibility has not been verified here.” Manifest has no egress and no LLM — likely eligible, **needs verification** against the current program checklist (Forge docs). It is **not** a 2026 bonus prize (it was in 2025).
  - `package.json` `"main": "index.js"` — that file does not exist at the repo root. Forge uses `manifest.yml` handlers (`src/index.js`). Harmless but sloppy.
  - README mermaid used the baseline scaffold key (now `qualityloop-issue-panel`, QL-013/T28).
- **Solution:** Fix the AGENTS sentence; set `"main": "src/index.js"` or remove `main`; after verifying Runs on Atlassian, replace the sentence with a dated yes/no and a checklist link; keep no-egress.  
- **Acceptance:** No “built later.” `main` points at a real file or is omitted. README is consistent with `manifest.yml`.  
- **Effort:** S.

### QL-028 — English-only UI; DatePicker locale `en-CA`; limited explicit a11y

- **Severity:** Medium  
- **Category:** A11y / i18n  
- **Location:** All user strings are English literals. `CaptureForm.jsx` DatePicker `locale="en-CA"`. Errors in some places use `SectionMessage appearance="error"` (good); Decision modal validation is plain `Text` (`DecisionDetails.jsx:32`). No Forge i18n modules. UI Kit may provide focus management for Modals — **needs verification**.  
- **What’s wrong:** Fine for Codegeist (submission materials must be English). Weak for Marketplace and non-English Jira sites. DatePicker locale may confuse non-CA users even though the format is ISO.  
- **Why it matters:** Design, Marketplace bonus later.  
- **Solution (deadline):** Keep English. Set DatePicker locale to the user’s locale if UI Kit supports it (**needs verification**), keeping `dateFormat="YYYY-MM-DD"` for storage. Move modal validation into `SectionMessage appearance="error"`. Ensure every icon-only or loading state has a `label` (Spinner already has). Do not start a full i18n framework before the deadline unless leftover time.  
- **Acceptance:** Modal errors use SectionMessage. DatePicker locale choice is documented. Keyboard path through capture → decision → confirm works in a manual check (owner).  
- **Tests:** Limited; frontend tests can assert SectionMessage on validation.  
- **Effort:** S–M.

### QL-036 — Minimal lint, no TypeScript

- **Severity:** Low  
- **Category:** Hygiene  
- **Location:** `.eslintrc` only `react-hooks/rules-of-hooks`. No `engines`. JS not TS. The project’s runtime checks and tests carry the invariants.  
- **Solution:** Optional: add `eslint:recommended` and `engines: { "node": ">=22" }`. Do **not** rewrite in TypeScript before 23 Dec — regression risk, low judging value.  
- **Effort:** S if lint only. L if TS (not recommended now).

---


## 3. Feature and strategy gaps (for winning, not just fixing)

These are not defects in existing code. They are the work most likely to move Codegeist scores (Impact, Innovation, Presentation) and to open bonus prizes. Each is specified at a level Claude can turn into a Codex prompt. Respect §1.3 constraints: no AI **matching**, no `asApp()` for user-visible data, no silent fuzzy matching, no auto-declaration that a CAPA failed.

### 3.1 Rovo agent (or skills/actions) that **query** decisions — Best Agents bonus

**Why:** 2026 bonus “Best Agents – Rovo/Assignable agents” ($1,500 × 6) requires a Forge app with `rovo:agent`, `rovo:agentConnector`, or reusable `rovo:skill` / `rovo:action` that other agents can invoke. Last year’s Specialized 1st and 2nd won this track as well as the category. A **thin** “Rovo wraps the matcher” will look cynical and would violate the product’s honesty. A **query** agent is aligned: the context is already stored; the agent retrieves it.

**Must not do:** Classify recurrence. Confirm or reject on the engineer’s behalf. Invent CAPAs that were not stored. Bypass `asUser()`.

**Spec:**

1. Read current Forge Rovo module docs before writing `manifest.yml` (Forge MCP / official docs). Do not invent module properties. New scopes, if any, must be listed for the owner (`forge install --upgrade`).
2. Add one agent, e.g. “QualityLoop recurrence assistant,” conversation starters:
   - “Which CAPAs in this project have more than one engineer-confirmed recurrence?”
   - “Show decisions for CAPA {key}.”
   - “What is still an open effectiveness concern?”
3. Actions (tools), each implemented as a resolver that:
   - Uses `api.asUser()`.
   - Takes issue **keys**, not raw ids from the model, and resolves them with a user GET first (same rule as `recordDecision`).
   - Returns only issues the user can browse; omit the rest; never reveal hidden counts.
   - Returns structured data: keys, states (`STATE_LABELS`), confirmed counts if already computed, last decision reason, links to `/browse/{key}`.
   - Time-budgeted like `loadEvidence`.
4. Suggested actions: `listConfirmedRecurrences({ projectKey, minCount })`, `getPairHistory({ ncKey, capaKey })`, `listOpenConcerns({ projectKey })`. Reuse `getPairState`, `queryRecords`, `pairConfirmed`. Prefer JQL to find NCs/CAPAs in the project (QL-033), then KVS by issue.
5. The agent’s system prompt (or instructions field, per current API) must say: “You report QualityLoop **recorded** decisions only. You never assert that a CAPA failed. If no record exists, say so.”
6. Demo: in the video, 20–30 seconds of Rovo answering “which CAPAs have confirmed recurrences?” after two sample decisions. This is also the 2026 “context” story.

**Acceptance:** Manifest includes a documented Rovo module; actions authorised asUser; a hidden issue is omitted; the agent refuses to “confirm this is a recurrence” without a stored CONFIRM; judge instructions include how to open the agent. Tests: action resolvers with mocked Jira/KVS (allow/deny).

**Effort:** L (docs + implementation + demo). Start only after QL-001’s install path is stable. Can land in the last two weeks.

**MCP (Best app with Atlassian MCP):** If the same tools are exposed via `rovo:mcp` (resources page: “exposes tools via the Atlassian MCP server using the `rovo:mcp` module” — **use the official rules text and current docs, they differ slightly from the overview**), you can also compete for that $1,500. Only do this if the Rovo actions are already solid; do not build MCP first.

**Teamwork Graph (Best TWG integration):** Optional second bonus. Ingest NC/CAPA signatures (part, FM, dates, record type) as graph objects, or consume graph data — **docs first**. This is the most “2026 context” platform feature. Effort L, higher uncertainty. Only if Rovo is done and time remains. Do not block the video on TWG.

---

### 3.2 Configurable failure modes (and default-catalogue alignment)

**Why:** QL-003. Without this, a real plant cannot adopt the app. Judges in Specialized Industries notice hard-coded toy codes.

**Spec:**

1. Default list: one consistent catalogue (align labels; see QL-003). Include `code` (stable, normalised, e.g. `FM-01`) and `label` (display).
2. Storage: KVS `fm-catalog:<cloudId or "site">` or per-project `fm-catalog:<projectId>`. Prefer **site-wide** so matches work across projects, with an optional project override. Schema: `{ version, modes: [{ code, label, active }] }`. Codes are `^[A-Z0-9][A-Z0-9_-]{0,31}$` after `normaliseText`. Max 50 modes. Cannot delete a code that is in use (deactivate instead).
3. Admin UI (QualityLoop data page or project page, permission: Jira admin or project admin — **verify**): list, add, rename label, deactivate. Not a free-text field on the capture form (that would destroy matching).
4. `FAILURE_MODES` in `src/config/failureModes.js` becomes the **default seed**. `validateCapture` and the form Select load the active catalogue from a small resolver `getFailureModes`. Cache on the server per invocation. If KVS is empty, use the seed.
5. `buildCapture` stores the **code**. Cards resolve the label from the catalogue and fall back to the raw code if deactivated.
6. Migration: existing `FM-01`…`FM-99` remain valid. Eval frozen data is not changed.
7. Sample scenario keeps DEMO FMs from the default seed (`FM-01`, `FM-07`, `FM-03`).

**Acceptance:** A judge can add `FM-08 Wire fracture` on the admin page, save a CAPA and an NC with that code, and get a strong match. Default seed works with zero configuration (demo). Tests for validation, deactivation, and default fallback.

**Effort:** M.

---

### 3.3 Project-level recurrence dashboard

**Why:** The operational payoff of all the stored pair-state. Impact criterion. Currently counts exist only on a CAPA card, and only after you already found it.

**Spec:**

1. **Placement:** The existing QualityLoop **project page**, above or beside the sample buttons. After the sample is used, this is what remains useful.
2. **Data path (deadline, no schema change):** JQL asUser: `project = {id} AND qlRecordType = NC` (and maybe CAPA), capped and paginated, budgeted. For each visible NC, `queryRecords(PAIR_ENTITY, 'by-issue', ncId)`. Authorise CAPA ids with GET asUser. Render a table:
   - NC key, CAPA key, current state (lozenge), confirmed-count for that CAPA if cheap, last decision date, link to both issues.
   - Filters: state = CONFIRMED / CONCERN_RAISED / all.
   - Empty state: “No decisions in this project yet. Create the sample or save an NC.”
3. **Permissions:** same as project page (`projectContext`). Omit unbrowsable issues. No totals of hidden records.
4. **Performance:** 15s budget, cap (e.g. 50 rows), disclose incompleteness. Do not N+1 without batching (batches of 5, already a pattern).
5. Optional later: `projectId` on `pair-state` + index (QL-033) for scale.

**Acceptance:** After recording a confirmation on the sample NC, Refresh on the project page shows that row without opening the issue. A user who cannot browse the CAPA does not see its key. Tests with mocked JQL + KVS.

**Effort:** M–L.

---

### 3.4 Marketplace listing — Best Marketplace published app

**Why:** The only 2026 bonus ($1,500 × 6) that does **not** require a new platform module. “Published to the Marketplace **or submitted for listing**” — provide the listing URL or the review ticket.

**Spec (process, owner-run):**

1. Complete Atlassian Marketplace partner listing for a **free** (or paid, owner’s choice) Forge app. Privacy policy URL (QL-040), support contact, screenshots (QL-001), description using the §3 / QL-014 pitch.
2. Security questionnaire: no egress, scopes listed, `PRIVACY.md` summary, `docs/SECURITY-DEPENDENCIES.md` one-liner.
3. App must install from the Marketplace/review build that matches the submission video.
4. Put the listing or ticket URL on Devpost (bonus write-up).
5. Visible name must not collide with the 2025 Quality Loop (QL-012).

**Acceptance:** Devpost bonus section has a live URL. Judges can open it.

**Effort:** M (calendar time, mostly the owner). Start in week 2; Marketplace review can take days.

---

### 3.5 Configurable lookback and historical CAPA import

**Why:** The 365-day window missed labelled-true NC-002/CAPA-17 (384 days). Plants often want 2–3 years. A fresh install with no history is a weak Impact demo unless the sample is used.

**Spec:**

1. `lookbackDays` (`src/config/matching.js`) becomes a project setting: 90 / 365 / 730 / 1095, default 365. Used by `windowStart`, `buildMatchJql`, hints (“outside the N-day window” copy must use the setting). Evidence heading shows the window.
2. **Bulk import (optional):** a project-page “Import CAPAs from CSV” or “Register existing issues”: CSV columns matching capture fields; validate with `validateCapture`; write properties asUser; confirmation dialog listing **N writes**; cap (e.g. 100 per confirmed batch); do not auto-transition Jira status. This is L and easy to get wrong — only if dashboard and sample path are already solid.

**Acceptance:** Setting 730 makes a 400-day-old CAPA a strong match; heading says 730. Tests for `windowStart` and JQL. Import, if built, never writes without confirmation.

**Effort:** S for lookback; L for import (defer).

---

### 3.6 What not to build before 23 Dec

- AI / LLM classification of recurrence.
- A generic “chat with your Jira” wrapper.
- TypeScript rewrite.
- Changing trash-deletion policy to be more aggressive (404 is not proof).
- `npm audit fix --force`.
- Background monitors / scheduled “scan all NCs” (out of the original product rules unless a small scheduledTrigger is clearly needed; AGENTS.md says no scheduled triggers unless a task asks).
- JSM-specific modules unless you already use JSM in the demo — **needs verification** that the panel already appears on JSM issues; if it does, mention it, don’t rebuild.

---

## 4. Submission checklist

Official requirements: https://codegeist2026.devpost.com/ and https://codegeist2026.devpost.com/rules.

**Deadline:** Wed 23 Dec 2026, **1:30 AM IST** (Tue 22 Dec 2026, 12:00pm PST). Submit at least 24 hours early.

### 4.1 Form and eligibility

- [ ] Entrant is eligible (India is not on the excluded list; age of majority).
- [ ] Category: **Apps for Specialized Industries** (do not put this in Software Teams).
- [ ] Bonus boxes only if truly implemented: Rovo / MCP / Teamwork Graph / Marketplace (URL or review ticket).
- [ ] Text: what it does; how it meets Forge + Jira; the **context** pitch (QL-014); disambiguation from the 2025 Quality Loop (QL-012).
- [ ] Public GitHub repo (already is); commit that matches the deployed app.
- [ ] English throughout (or English translations).
- [ ] Original work, MIT already in repo.

### 4.2 Installation

- [ ] `forge deploy` of the submission build (owner).
- [ ] Share link per https://developer.atlassian.com/platform/forge/distribute-your-apps/#start-sharing-your-app
- [ ] `docs/JUDGE-INSTRUCTIONS.md` (see QL-001). Tested on a **fresh** site by following only that doc.
- [ ] Required for the happy path: a project where the judge can Create and Edit issues; standard Task type (or your fallback, QL-021); Relates link type enabled; no blocking required custom fields, or a note to use an empty project.
- [ ] Sample path works: five DEMO issues, readiness or clear “open the NC anyway,” Save on DEMO new NC shows at least one strong or related-revision card (DEMO-5520-A / FM-07 vs DEMO CAPA-B).

### 4.3 Video script outline (< 5:00, public YouTube, no copyrighted music)

Judges are not required to watch past 5 minutes. Show the **app working**, not a slide deck.

| Time | What | Why |
|---|---|---|
| 0:00–0:25 | Who it is for (quality engineer in manufacturing). The context sentence (QL-014). “It never declares a CAPA failed.” | Presentation, theme, Stage One |
| 0:25–0:50 | Screen: project page → Create sample → confirm the listed writes (show the confirmation, it is a design strength) | Design, trust |
| 0:50–2:10 | Open DEMO new NC, QualityLoop panel, Save. Walk a **strong match** card: part, FM, closed date, days, evidence link, Done-status warning if any. Say the rule in one breath: “exact part and failure mode, closed 1–365 days before detection, your permission only.” | Implementation, Design |
| 2:10–2:40 | Expand/show hints (QL-007 must make this visible). “These are not matches. This is a near-identical part / missing date / older precedent.” | Innovation, honesty |
| 2:40–3:40 | Record Engineer-confirmed recurrence with a short reason. Show history and the confirmed count. Then Effectiveness concern → confirmation dialog (read the writes aloud) → created Task. Open the Task and show **description + links** (QL-005). | Impact, complete product |
| 3:40–4:20 | Optional: project dashboard (if §3.3 done) and/or Rovo query “which CAPAs have confirmed recurrences?” (if §3.1 done). If not done, 20s on Data health / permissions (“as you, not as the app”). | Bonuses / Implementation |
| 4:20–4:50 | Eval in one sentence: “On a frozen synthetic set, exact-rule correctness is 18/18; some true precedents are only hints, on purpose.” Do not claim field performance. | Honesty, Innovation |
| 4:50–5:00 | Close: “Install with the share link. Sample takes two minutes.” | Call to action |

Record in a quiet room, 1080p, browser zoom so cards are readable, English spoken clearly. Do **not** use copyrighted music. Show real UI, not mockups.

### 4.4 Screenshots (Devpost + README)

1. Issue panel after Save, strong match + decision lozenge.  
2. Hint card with the “not a match” disclaimer.  
3. Follow-up confirmation dialog.  
4. The created Jira Task with description (after QL-005).  
5. Project page (sample and, if built, dashboard).  
6. Optional: Rovo answering a query.

### 4.5 Naming

- [ ] Visible title disambiguated (QL-012).
- [ ] First paragraph of Devpost: not the 2025 hospitality app.

### 4.6 Pre-submit dry run (owner, T–3 days)

- [ ] Fresh demo site, follow only judge instructions, time it.
- [ ] Second person (or you on a second account with only browse, no edit) sees read-only panel.
- [ ] Video still matches the build (re-record if UI copy changed).
- [ ] `npm test`, `npm run eval:dev`, `npm run lint` green on the tagged commit.
- [ ] Manifest scopes listed in the Devpost text. No unexpected `external` egress.

---

## 5. Suggested implementation order (~40 days: 13 Nov → 23 Dec 2026, 1:30 AM IST)

Do not start Rovo or Marketplace before the demo path is reliable. Dates are IST.

### Phase A — Days 1–7 (13–19 Nov): correctness and a reliable demo

1. QL-002 (required CAPA closed date) — S  
2. QL-004 (hyphen-space normalisation) + re-run eval — S  
3. QL-006 + QL-029 (URL validation) — S  
4. QL-008 (lock record type) — S  
5. QL-015 (JQL `<` vs `<=`) — S  
6. QL-007 + QL-035 (hints visible, copy) — S  
7. QL-013 (rename module key + icon) — S, then **owner reinstall**  
8. QL-005 (follow-up description + NC link) — M, most important product fix  
9. QL-020 dry-run sample on a fresh site — owner  

**Exit:** A stranger can install (even if the public share link comes later), run the sample, see a match, see hints, record a decision, and open a Task that contains the reason.

### Phase B — Days 8–18 (20–30 Nov): product completeness and CI

10. QL-003 minimum (align FM labels) and start §3.2 (configurable FMs) — M  
11. QL-009 presets for revision patterns + live preview — M  
12. QL-011 project-scope search, default “this project” — M  
13. QL-016 / QL-017 supplier and FM canonicalisation — S–M  
14. QL-018 capture OCC + author — M  
15. QL-026 GitHub Action + regression tests for Phase A bugs — S  
16. QL-027 docs cleanup; QL-014 draft pitch in README — S  
17. §3.3 dashboard (JQL path) — M–L  
18. §3.5 lookback setting — S  

**Exit:** Project page shows decisions. Failure modes and search scope are not toys. CI is green.

### Phase C — Days 19–30 (1–12 Dec): bonuses and evidence

19. §3.4 Marketplace submission started (calendar lead time) — M, owner  
20. §3.1 Rovo **query** agent — L, only if Phase A exit is met  
21. QL-012 final visible name  
22. QL-025 held-out eval run + optional engineer comment in DISPUTES — M, owner  
23. QL-010 hint JQL tighter — M (can be earlier if time)  
24. MCP/TWG only if Rovo is done and stable  

**Exit:** At least one bonus path is real (Marketplace and/or Rovo). Eval story is ready for the video.

### Phase D — Days 31–39 (13–21 Dec): submission package

25. QL-001 judge instructions, screenshots, share link  
26. Video (script §4.3), recorded on the submission build  
27. Devpost form draft; let it sit a day; re-watch the video against the criteria  
28. Second dry-run on a fresh site  
29. Submit **by 21 Dec 2026 evening IST**, not at 1:30 AM on the 23rd  

### Phase E — Buffer (22 Dec)

Only emergency fixes if the dry-run failed. Re-record the video if the UI changed. Do not start new features.

---

## 6. Codex prompt guidance (for Claude)

When writing prompts for Codex from this document:

- Always state: repo root, commit `17d0e6c` as the baseline (or later HEAD), “do not regress §1.3,” and “run `npm test`, `npm run lint`, and `npm run eval:dev` before finishing.”
- Give **one or a tight cluster of QL-IDs** per prompt (e.g. QL-002 alone; QL-006+QL-029 together; QL-007+QL-035 together). Do not dump all 40 into one prompt.
- Paste the issue’s **Solution, Acceptance, and Tests** sections verbatim.
- Tell Codex **not** to edit frozen files: `eval/corpus/capas.json`, `eval/dev/ncs.json`, `eval/dev/labels.json`, `eval/FROZEN.json`, `eval/test/**` if present.
- Tell Codex **not** to run `forge login`, `forge deploy`, or to request tokens (`AGENTS.md`).
- Tell Codex **not** to change `app.id` in `manifest.yml`.
- If a prompt touches `manifest.yml` scopes or module keys, the summary must tell the **owner** the exact `forge deploy` / `forge install --upgrade` / reinstall steps.
- For anything marked **needs verification**, Codex should look up current Forge docs rather than invent APIs, and should say in its summary what it could not verify.

---

## 7. What this review did and did not run

```
git pull --ff-only          # already 17d0e6c
npm ci                      # previously installed; not re-done this pass if node_modules present
npm test                    # 25 suites, 505 tests, all passed, 1.25s
npm run lint                # clean
npm run build               # “Checked UI Kit and resolver imports.”
npm run eval:dev            # L1 18/18, L2 recall 0.813, hints 0.938, precision 0.722
```

Throwaway edge-case tests (35, all “passed” as documentation of actual behaviour, then **deleted**, not committed) confirmed: optional CAPA closed date; `SM-6604 -A` base `'SM-6604 '`; JQL `qlClosed <=`; supplier case inequality; capture accepts credential URLs; same-day / 365 / 366 window; three-letter and numeric revisions are not revisions; CAPA-without-date is not a match.

**Not run:** `forge login/deploy/install/tunnel`, live Jira, held-out eval, `scripts/audit-dependency-paths.js` re-execution, Marketplace listing, Rovo modules (they do not exist yet).

---

*End of strict review. Issue IDs: QL-001–QL-040. Counts: 1 Critical, 13 High, 21 Medium, 5 Low.*
