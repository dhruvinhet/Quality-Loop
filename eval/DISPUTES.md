# Label disputes

Record any disagreement with a label here (date, NC id, CAPA id, who, reasoning). Never edit the frozen data files.

## 2026-11-01 - T7b: L1 matcher differences

The app differed from the pre-registered rules in `eval/README.md` in three ways:

1. It included CAPAs closed on the NC detection date (0 elapsed days). Eligibility now requires 1 through 365 elapsed days, inclusive.
2. It recognised only a trailing hyphen plus one letter as a revision. It now recognises one or two letters: `P-100-AA` has base `P-100` and revision `AA`.
3. It compared failure modes literally. It now uses the same normalisation as part numbers: trim, collapse inner whitespace, and uppercase. Original strings remain available for UI display.

Resolved: app changed to match pre-registered README rules; data unchanged.
