# Verification levels

Activate only the relevant detailed procedure: `unit-testing` for isolated logic,
`integration-testing` for real boundaries, `e2e-testing` for user flows,
`regression-testing` for before-and-after defect proof, and `app-verification` for
project-local verification guides.

Keep the command, output, real path and checked side effects with each proof claim.
Check runner output for skips and evidence paths. Automatic attachment depends on the
installed command and task selection; hooks depend on host support and configuration.
Neither a successful command nor a hook configuration proves complete behavioral coverage.
After two different fixes still leave verification failing, ask one focused question
with the failure evidence and a recommended next step.
