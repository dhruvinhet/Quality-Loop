# Label disputes

Record any disagreement with a label here (date, NC id, CAPA id, who, reasoning). Never edit the frozen data files.

## 2026-11-01 - T7b: L1 matcher differences

The app differed from the pre-registered rules in `eval/README.md` in three ways:

1. It included CAPAs closed on the NC detection date (0 elapsed days). Eligibility now requires 1 through 365 elapsed days, inclusive.
2. It recognised only a trailing hyphen plus one letter as a revision. It now recognises one or two letters: `P-100-AA` has base `P-100` and revision `AA`.
3. It compared failure modes literally. It now uses the same normalisation as part numbers: trim, collapse inner whitespace, and uppercase. Original strings remain available for UI display.

Resolved: app changed to match pre-registered README rules; data unchanged.

## 2026-11-13 - T24 / QL-004: spaces around hyphens are removed

This is an explicit change to the written part-number rules, rather than a label
correction or a claim that the original pre-registered rule already allowed it.
After trimming, collapsing inner whitespace and uppercasing, part numbers now
remove spaces around hyphens (`/\s*-\s*/g` → `-`). For example, `SM-6604 -A`
and `SM-6604-A` have the same normalised part and base. Original strings remain
unchanged for display. Failure-mode normalisation is unchanged.

The named rule is deterministic formatting normalisation, not fuzzy matching.
Typos still require explicitly labelled hints; different revisions remain related
revisions. NC-027 / CAPA-15 is now eligible for a strong match under these updated
rules, rather than only a formatting hint. This does not establish recurrence
without an engineer decision.

The independent reference scorer implements the updated written part rule without
importing application code. Frozen data was not touched: `corpus/capas.json`,
`dev/ncs.json`, `dev/labels.json`, and `FROZEN.json` are unchanged; `test/**` was not
opened or modified. Before/after measurements are recorded in `docs/tasks/T24.md`.

Measured on the frozen dev set: L1 remains **18/18**; L2 pair recall rises from
**0.813 (13/16)** to **0.875 (14/16)**; recall including hints stays **0.938 (15/16)**;
precision rises from **0.722 (13/18)** to **0.737 (14/19)**, excluding ambiguous
pairs. These are synthetic pure-logic results, not evidence of live Jira recall.
