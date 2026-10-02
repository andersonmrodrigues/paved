# Example: filling in an existing issue

Synthetic. The repository, its template and its paths are invented; only the shape
matters.

**Item as found.** Title "Export certificates", body "Students need to export their
certificates.", no labels.

**Template chosen.** No project addendum. The repository has its own issue template with
the fields *Summary*, *Motivation*, *Acceptance criteria* and *Notes*, so the task uses
those fields, in that order, instead of the default sections.

**Grounding found.** `src/certificates/view` renders one certificate on screen;
`src/reports/export` already exports reports as files and is the sibling to follow. No
code produces a certificate file today.

**Question asked, with options.** "The repository renders certificates on screen but
cannot produce a file. Which export is meant? (a) download one certificate as a file,
following the report export; (b) download all of a student's certificates at once;
(c) something else." The user chose (a).

**Result, written to `.paved/generated/tasks/export-certificates.md` and opened in the preview; the item's body was replaced after the user said yes in the chat.**

```markdown
### Summary
Students can download a certificate they earned as a file, from the certificate page.

### Motivation
Students need to share certificates outside the platform; today they can only view them
on screen.

### Acceptance criteria
- [ ] A student viewing an earned certificate can download it as a file with the same
      content shown on screen (end-to-end test).
- [ ] A student cannot download a certificate they have not earned (authorization test).
- [ ] Viewing a certificate keeps working as today (existing tests pass).

### Notes
- Follow the file export in `src/reports/export`; the certificate is rendered in
  `src/certificates/view`.
- Open question: which file format the institution accepts. Nobody has said, and the
  repository does not show one.
```

The title and labels were left as they were. The open question stayed open instead of
being answered with a likely format.
