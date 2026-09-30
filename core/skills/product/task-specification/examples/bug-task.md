# Example: bug task

Synthetic. The repository and its paths are invented; only the shape matters.

**Request.** "Password reset is broken for some users."

**Clarified.** The user reports that reset links fail for accounts whose email address
contains a plus sign.

**Grounding found.** `src/auth/reset/create-link` places the email address in the link
without encoding it; `src/auth/reset/confirm` looks the account up by the decoded value,
so a plus sign arrives as a space. Tests exist for the reset flow in
`tests/auth/reset/`, none with special characters.

**Result.**

```markdown
**Type:** Bug

## Description
Users whose email address contains a plus sign cannot reset their password: the reset
link says the account does not exist. Every such user who forgets their password is
locked out until support intervenes.

## Expected result
A reset link works for every valid email address, including ones with a plus sign.

## Acceptance criteria
- [ ] A reset requested for an address with a plus sign completes and the new password
      works (regression test that fails before the fix).
- [ ] Addresses with other characters that need encoding in a link also work (unit test).
- [ ] Reset links issued before the fix for ordinary addresses keep working.
- [ ] An expired or already used link is still rejected (existing tests pass).

## Technical context
- The link is built in `src/auth/reset/create-link` and read in `src/auth/reset/confirm`;
  the value is not encoded when the link is built.
- Add the regression case next to the existing tests in `tests/auth/reset/`.
- Open question: whether links already sent to affected users must keep working after
  the fix.

## Steps to reproduce
1. An account exists with the email address `ana+test@example.com`.
2. Request a password reset for that address.
3. Open the link from the email.
4. Actual: "Account not found". Expected: the form to choose a new password.
```
