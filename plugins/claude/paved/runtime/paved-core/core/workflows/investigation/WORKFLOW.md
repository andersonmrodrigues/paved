# Investigation

## When to use

A question about the code: how something works, why it is built that way, whether a
statement about it holds. The deliverable is an answer the user can check, not a change.
A request to change behavior, fix a defect or restructure code belongs in `feature`,
`bug` or `refactor`; a request to make something faster belongs in `performance`. When
the user asks to investigate a failure without fixing it, this is the workflow. A short
factual question that one file answers needs no run; answer it directly.

The run is read-only. It has no planning or implementation phase, so it needs no plan
approval and can never authorize a fix. The `read-only` Tool policy denies every Core
Tool that changes state, and the verification phase fails when a source or test file
changed after the run started.

## Phases

- **context:** restate the question and what a complete answer covers. Ask when the
  question has two readings; do not answer both silently.
- **discovery:** read before concluding. Write the answer at
  `.paved/documents/research/<run-id>.md` and advance with `--evidence <answer>`. Paved
  parses it: an `## Answer` section, a `## Claims` list and a `## Recommendation`
  section. Each claim starts with its label, and its sources are inline code spans:

  ```markdown
  ## Claims

  - [observed] Requests are validated before routing. `src/router.ts:42-58`
  - [inferred] The retry exists for the old queue, not the current one. `commit 3f9c2a1`
  - [observed] Only one caller remains. `$ <the search command you ran>`
  - [unknown] Whether the limit is still needed; no test or commit explains it.
  ```

  `observed` is something you read or ran; `inferred` follows from observed facts and
  says so; `unknown` is what the code cannot settle, which
  `core.quality.unknowns-stay-unknown` asks you to keep unknown. Observed and inferred
  claims need at least one source. Paved checks that each `path:line` exists in the
  checkout and that each commit resolves; a `$ command` source is recorded as stated,
  so quote its relevant output in the claim.
- **verification:** Paved resolves the citations again and compares the source digest
  with the one taken when the run started.
- **completion:** report the answer. When it concludes a change is needed, the
  recommendation names the workflow for it (`feature`, `bug`, `refactor` or
  `performance`); the user starts that run with `intent`. Never make the change here.

## Escalation

Stop and ask when answering needs access the run does not have (production data, a
running system, a person's decision), or when the only way to find out is to change the
code; recommend a run of the right kind instead.
