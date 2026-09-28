# Example: investigation log

Synthetic. The domain is invented; only the shape matters.

**Report.** "Exported reports are missing the last row." Observed by a user on the report
export screen; no error shown.

| # | Step | Observation | Conclusion |
|---|---|---|---|
| 1 | Export a report with 3 rows locally | File has 2 rows | Reproduced |
| 2 | Export with 1 row | File has 0 rows | Always loses exactly one row |
| 3 | Export with 0 rows | Empty file, no error | Consistent with losing one row |
| 4 | Read the export loop | Loop runs while index is less than count minus one | Hypothesis: off-by-one in the loop bound |
| 5 | Change only the bound in a scratch copy | 3 rows exported | Cause confirmed |
| 6 | Version history of the file | Bound changed two weeks ago in a "cleanup" | Regression; introduced by that change |
| 7 | Search for the same loop shape | One other exporter uses the same bound | Second occurrence; confirmed with a test |

**Cause.** The loop bound excludes the last row (step 4), confirmed by step 5.

**Regression test.** "exports every row": fails before the fix (2 of 3 rows), passes
after.

**Unknowns.** Whether reports exported in the last two weeks need regenerating; asked
the owner.
