# Example: task review

Synthetic. The repository and its paths are invented; only the shape matters.

**Task as written.**

```markdown
Title: Improve order search

Search is slow and users complain. Add an index to the orders table and a new
/orders/search endpoint so users can search by customer name.

- Search should be fast
- Should work well
```

**Intent.** Users find orders by customer name quickly.

**Checked in the repository.** `src/orders/search-handler` already serves a search
endpoint, with filters by number and date; storage migrations live in `db/migrations/`;
the verification profile has a performance check with a budget for list endpoints; the
architecture rules say new public endpoints need the owner's approval.

**Verdict:** `needs changes`

**Blocking findings.**

| # | Source | Finding |
|---|---|---|
| 1 | Description; `src/orders/search-handler` | A search endpoint already exists; the task asks for a new one instead of extending it |
| 2 | Acceptance criteria | "Should be fast" and "should work well" cannot be verified |
| 3 | Description | Implementation (index, endpoint) with no expected result stated |
| 4 | Type | No type; the content describes an improvement to existing behavior |

**Notes.** The public endpoint rule would apply only if a new endpoint remained.

**Rewrite.**

```markdown
**Type:** Improvement

## Description
Users look up orders by customer, but search only filters by order number and date,
so they scroll through results. Searching by customer name must be possible and stay
within the response budget for lists.

## Expected result
Order search accepts part of a customer name and returns matching orders, within the
list budget in the verification profile.

## Acceptance criteria
- [ ] Searching with part of a customer name returns only orders of matching customers
      (integration test).
- [ ] The match ignores letter case and accents (unit test).
- [ ] Searches by order number and date behave as before (existing tests pass).
- [ ] With the largest data set the performance check uses, the search stays within the
      list budget (performance check).

## Technical context
- Extend the existing search in `src/orders/search-handler` rather than adding an
  endpoint.
- Any storage change goes in a new migration in `db/migrations/`.
- Open question: whether matching on accents is expected by users outside the product's
  primary language.
```

**What changed.** Type added; description restated as the problem; new endpoint
replaced by extending the existing search; vague criteria replaced by verifiable ones;
the index moved from the requirement to an implementation choice.
