# QualityLoop evaluation dataset (frozen 2026-11-01)

This folder measures two things separately:

- **L1, signature correctness.** Does the app's matcher return exactly the CAPAs that the written rules say it should?
- **L2, expert usefulness.** Are the CAPAs it surfaces real precedents for the NC (judged by failure mechanism), and does it miss any?

The dataset was written **before** the evaluation harness, and its file hashes are recorded in `FROZEN.json`. Do not edit any file after freezing. If a label looks wrong, write the disagreement down in `eval/DISPUTES.md`; do not change the file.

## Honesty statement

- All data is **synthetic**: a fictional automotive-component plant, with fictional suppliers and part numbers.
- The cases and labels were written by the project team with AI assistance. **They are not validated by an independent quality engineer.** If an interview contact agrees to review `labels.json`, record their comments in `DISPUTES.md`.
- The cases were written as *mechanism stories*: what really caused each defect and which CAPA's action targeted that cause. They were **not** written by running the matcher and choosing outputs.
- The dataset deliberately includes realistic cases that a conservative exact matcher **cannot** catch: typos, a wrong failure mode, a missing closure date, closure outside the window, and part numbers stored inconsistently. These count against recall. They are there so that the score cannot be met trivially.
- Results must be reported as measured on this synthetic set. Never present them as field performance.

## Files

| Path | In repo? | Contents |
|---|---|---|
| `corpus/capas.json` | yes | 24 CAPA records (shared by both splits) |
| `dev/ncs.json`, `dev/labels.json` | yes | 18 NC cases with labels. Codex may read these. |
| `test/` | **no** | 42 NC cases. Kept **outside the repository** until the final evaluation. Only its hashes are in `FROZEN.json`. |
| `reference/score.js` | yes | Independent scorer. It shares no code with `src/`. |
| `FROZEN.json` | yes | SHA-256 of every data file. The scorer refuses to run if any file has changed. |

### Record shapes

- **CAPA:**
  - `id`, `part` (stored exactly as typed, including stray spaces), `failureMode`, `supplier`, `line`
  - `closedDate` (the qlClosed value, or `null`), `jiraStatus`
  - `rootCause`, `actionsTaken`, `effectivenessEvidenceUrl`
  - `dataNote` (explains data-quality traps; the app must not read it)
- **NC (input):** `id`, `summary`, `description`, `part`, `failureMode`, `supplier`, `line`, `detectedDate`.
- **Label:**
  - `pairs`: CAPA id mapped to `TRUE`, `NOT` or `AMBIGUOUS`. Any pair not listed is `NOT`.
  - `trap`: the case category.
  - `mechanismNote`: why the label is what it is.

### Label meanings (pair level)

- **TRUE:** the NC has the same failure mechanism as the CAPA's root cause, and the CAPA's action was meant to prevent it. An engineer *should* see this CAPA.
- **NOT:** the fields may match, but the mechanism is different, or the CAPA was still open or closed after this NC.
- **AMBIGUOUS:** there isn't enough evidence to decide. Excluded from precision; never counted as a miss.

## L1 rules (the reference specification)

1. `norm(x)` = trim, collapse inner whitespace to one space, uppercase.
2. Revision = a trailing `-<1–2 letters>` suffix of the normalised part. Base = everything before it. With no suffix, base = whole part and revision = "".
3. A CAPA is eligible only if `closedDate` is present and `1 ≤ detectedDate − closedDate ≤ 365` days. A same-day closure does not count.
4. **strong:** eligible, same normalised part, and same normalised failure mode.
5. **relatedRevision:** eligible, same base, different revision, and same failure mode.
6. Supplier and line are supporting facts only; they never create or remove a match. `otherRelated` is not scored.

If the app disagrees with a rule here (for example on the day boundary), that is a finding. Decide which behaviour is correct, record it in `DISPUTES.md`, and fix the app or explain the difference. Do not edit the dataset.

## L2 metrics and targets (set before any results)

| Metric | Definition | Target |
|---|---|---|
| L1 correctness | NCs where predicted `strong` and `relatedRevision` sets equal the reference exactly | all |
| Pair recall | TRUE pairs surfaced ÷ all TRUE pairs | ≥ 0.95 on test |
| NC-level recall | NCs with at least one TRUE pair surfaced ÷ NCs with any TRUE pair | reported |
| Pair precision | TRUE ÷ (TRUE + NOT) among surfaced pairs | reported, no target |
| Review burden | surfaced cards per NC | avg ≤ 3, max ≤ 6 |

"Surfaced" means the CAPA is in `strong` or `relatedRevision`.

Low precision is expected and acceptable by design. The app only says *possible* recurrence, and the engineer decides. Missed TRUE pairs are the costly error, so recall is the headline number.

Every miss is printed with its trap category, so the report can separate:

- misses a correct exact matcher should not make (bugs), from
- misses that are outside the conservative matching rules by design (typos, wrong failure mode, missing closure date, outside the window).

## How to run

The harness (built separately) writes a predictions file in this format:

```json
{ "NC-001": { "strong": ["CAPA-01"], "relatedRevision": [] } }
```

Then run the scorer:

```
node eval/reference/score.js --split dev --data eval/dev --predictions eval/out/dev-predictions.json
node eval/reference/score.js --split dev --data eval/dev --print-expected
```

The test split is run **once**, by the owner, at final evaluation, from its private folder:

```
node eval/reference/score.js --split test --data <private-folder>/test --predictions eval/out/test-predictions.json
```

After the final test run, the test folder may be added to the repository so judges can reproduce the numbers.
