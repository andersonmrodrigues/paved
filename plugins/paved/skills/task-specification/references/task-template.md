# Task template

The default shape of a task written for a tracker. Write the content in the language the
user writes in; keep the section order.

## Which template applies

Use the first that exists, and say which one you used:

1. The project addendum that extends `core.product.task-specification`.
2. The repository's own issue or task template, in the place the project's code host or
   tracker reads templates from. Keep its sections, field names, order and allowed
   values; fill in its fields instead of adding sections it does not have.
3. The default below.

When the chosen template lacks a section this file requires (for example acceptance
criteria), put that content where the template leaves room for it instead of adding a
section the team did not ask for.

## Default template

```markdown
**Type:** Feature | Bug | Improvement | Technical debt

## Description
What is being asked and why, in two to five sentences a reader outside the team
understands. For a bug, what happens today and who it affects.

## Expected result
The observable state of the system once the task is done, stated as behavior, not as
implementation.

## Acceptance criteria
- [ ] One observable, verifiable condition per line.
- [ ] Edge cases the request implies: empty or missing data, limits, a dependency failing.
- [ ] What must keep working (regressions the change could cause).

## Technical context
Only when it helps whoever implements the task:
- Affected areas and files, as paths that exist in the repository.
- The existing pattern to follow, pointing at one sibling.
- Constraints from the project's rules, boundaries or integrations.
- Open questions the repository does not answer.

## Steps to reproduce
Only for a bug:
1. Starting state (data, configuration, user role).
2. Each action, in order.
3. Actual result, then expected result.
```

## Types

| Type | Use for | Required beyond the common sections |
|---|---|---|
| Feature | Behavior the system does not have yet | Acceptance criteria covering each new outcome |
| Bug | Behavior that differs from what was intended or documented | Steps to reproduce; actual versus expected result |
| Improvement | A better version of behavior that already works | The current behavior, stated in the description |
| Technical debt | Internal change with no intended behavior change | Criteria that prove behavior did not change |

## Omitting a section

Omit `Technical context` only when the task touches nothing the repository can inform, and
`Steps to reproduce` for every type other than Bug. Never leave a section with a
placeholder; omit it or fill it.
