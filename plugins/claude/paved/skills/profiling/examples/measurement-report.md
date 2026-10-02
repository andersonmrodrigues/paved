# Example: measurement report

Synthetic. Names and numbers are invented.

**Question.** Why does the "list orders" operation miss its budget (95th percentile
under 300 ms)?

**Measurement.** 95th percentile and median of response time; 2000 requests against a
data set of 50 000 records; staging-class environment with no other load; first 100
requests discarded; 5 runs.

| | Median | 95th percentile | Spread (95th, across runs) |
|---|---|---|---|
| Baseline | 180 ms | 640 ms | ±25 ms |
| After change | 95 ms | 210 ms | ±15 ms |

**Profile.** 70% of wall time in waiting on storage; one query per listed item to load
its customer (a query inside a loop).

**Change.** Load the customers for the whole page in one query. Nothing else changed.

**Behavior.** Unit and integration suites for the module pass; the response content is
identical for a sample of 20 pages.

**Conclusion.** The 95th percentile is now under the budget; the improvement is far
larger than the spread.
