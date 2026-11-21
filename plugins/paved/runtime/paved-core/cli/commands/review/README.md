# `paved review plan`

`paved review plan` recommends review lenses for staged, unstaged and untracked
changes relative to `HEAD`. With `--base <ref>`, it includes committed changes
since the merge base as well. Fewer than 50 changed lines require no reviewer,
50–300 require one, and larger or sensitive changes require three. Binary files
and unknown line counts are treated conservatively.

The defaults recognize sensitive paths such as authentication, migrations,
permissions, payments and personal data. Add project patterns in
`.paved/review.yaml`:

```yaml
apiVersion: paved/v1
kind: ReviewPolicy
sensitive_paths:
  - src/secrets/**
```

These patterns supplement, rather than replace, the defaults. The result is a
recommendation; it does not dispatch reviewers or enforce a gate. Use
`paved review --base <ref>` or `--range <a..b>` to prepare a review and validate
its evidence.
