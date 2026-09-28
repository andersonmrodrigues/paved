# Execution ledger — conversational decision resolution

> **What this is.** The working record of an agent-driven execution of
> [the implementation plan](../plans/2026-09-28-conversational-decision-resolution.md),
> preserved because it holds the *reasoning* behind decisions that the git history only
> shows the result of. Every entry marked `Ruling:` is a judgement call made during
> execution, with its justification and what it costs if it turns out wrong.
>
> **This run is INCOMPLETE.** It covers Tasks 1–9 of 29. Task 9 is committed but was never
> reviewed — its review was interrupted. Tasks 10–29 were not started.
>
> **Known deviation:** two plugin-packaging tests fail on this branch by explicit decision.
> Adding schemas makes the checked-in packaged plugin stale, and a git-dlp `ZippedFilePolicy`
> hook blocks committing the regenerated `.tgz`. The acceptance criteria *"plugin drift check
> passes"* and *"clean-room plugin tests pass"* are therefore **not met on this branch**.
>
> **Reading the SHAs:** branch history was rewritten once, after Task 2, to change commit
> authorship. The remap table below translates pre-rewrite SHAs; entries written before it
> use the old values.

---

# SDD ledger — plan: docs/superpowers/plans/2026-09-28-conversational-decision-resolution.md

Spec: docs/superpowers/specs/2026-09-28-conversational-decision-resolution-design.md (reachable)
Branch: worktree-conversational-decisions
Baseline: 6ddef8e + b3e49c4 (docs). `npm run check` = 572 pass / 0 fail, typecheck clean.

## !! SHA REMAP — history rewritten after Task 2 (authorship change) !!

Human directive: commits must be authored as &lt;requested-address&gt; (was
&lt;previous-address&gt; from ~/.gitconfig). Set repo-locally via `git config user.email` +
`user.name "Anderson Rodrigues"` so subagent commits inherit it automatically, then
rewrote the four existing unpushed commits with `git filter-branch --env-filter` over
`6ddef8e..HEAD`. Content unchanged; only author/committer identity.

| Old SHA | New SHA | Subject |
|---|---|---|
| b3e49c4 | 20ec37c | docs: spec and implementation plan |
| 2439db6 | 4ef4c91 | feat: add Decision document schema |
| b364fe9 | 6e37279 | fix: shared sha256 def + allOf coverage |
| 83b11b3 | e18ebba | feat: decision record types and state machine |

Follow-up from human: &lt;previous-address&gt; is also acceptable. Both identities are therefore
sanctioned; keeping &lt;requested-address&gt; (the explicitly requested one) rather
than rewriting history a second time for no functional gain. Reversible with one
`git config user.email` change plus, if desired, another filter-branch.

Pre-rewrite recovery point (reflog): 83b11b3c63aa8ddd14d7dc35e5ad3ae763086f86.
ALL SHAs written below this block BEFORE this entry use the OLD values — translate via
this table. Entries after it use the new values.

## Pre-flight conflict scan

### Shared-file / shared-interface pairs

| Tasks | Produces → Consumes | Finding |
|---|---|---|
| T1 → T2,3,4,5,6,10,11,12 | `decision.schema.yaml` → `Decision` type | OK, but see Ruling 2 (missing `handler` field) |
| T2 → T3,4,5,6,10,11,12 | `record.ts` types, `transition`, `decisionId` | OK |
| T3 → T11,12 | `fingerprintOf`, `isStale`, `supersede` | OK |
| T4 → T9,11 | `parseAnswerFlags`, `validateAnswer`, `assertAnswerIdentity` | OK |
| T5 → T11,12 | `EFFECT_TIERS`, `tierFor`, `AGENT_ASSIGNABLE_EFFECTS` | OK |
| T6 → T11,12,16,19 | `listDecisions`, `readDecision`, `writeDecision` | OK |
| T7 → T8,9,11,12 + all command tasks | `DecisionProjection`, `awaiting_input`, exit 10 | OK; `gate.ts` imports `../../result.ts` = `cli/result.ts`, no cycle |
| T9 ↔ T12 | both modify `cli/runtime.ts` | Sequential; T12 must preserve T9's `--answer`/`--answered-by` branch |
| T10 → T11 | `readDecisionApproval`, `decisionDigest` | OK |
| T11 → T12,14,15,17,18,20,21,22,23 | `runDecisionGate`, `toProjection`, `HandlerRegistration` | **Rulings 1 & 2** |
| T12 ↔ T11,T21 | agent-raised decisions written straight to store | **Ruling 1** — gate drops them |
| T13 → T21 | `WorkflowRun.decisions[]`, `awaiting-input` | OK; T13 unit-tests `assessRun` with minimal objects, T21 uses full records — compatible |
| T14 → T15,18,20,28 | `detectCheckCandidates`, `verificationProvider` | OK |
| T15 → T18,27 | `verificationHandler` | OK |
| T16 → T18 | `resolveCapability(…, answered)`, `capabilityProvider` | **Ruling 4**; `capabilityHandler` built here per plan self-review |
| T17 → T18 | `rulesProvider`, `rulesHandler` | OK |
| T20 → T27,28 | `TestingToolResolution.ambiguous` | **Ruling 5** — `runTesting` call site breaks |
| T19 ↔ T20 | `consumer-state.ts` ↔ `agent-commands.ts` | Deferred minor: `status` now runs `inspectConsumer` twice |
| T25 → T27 | `interaction`/`decisionSources`/`answerChannels` | OK |
| T5,T10,T28 | all extend `tests/decisions/security.test.ts` | Duplicate `node:test` import statements; harmless, note only |
| T7,T8,T9,T12 | all extend `tests/cli/decisions.test.ts` | OK, additive |
| T14,T15,T17 | all extend `tests/decisions/providers.test.ts` | OK, additive |
| T7,T12,T20,T25 | all touch `tests/agent-contract/synthetic-agent.test.ts` | OK, additive |

### Per-task internal consistency

T1–T10, T13–T15, T17–T19, T21–T27, T29: internally consistent — the tests specified match the
code specified, and files created are the files later referenced.

T11: **inconsistent** — see Rulings 1, 2, 3.
T12: code block imports a non-existent `supersedeReasonRequired`; plan already flags and corrects it inline. OK.
T16: code block casts `decision.capability`, then the following prose says that field does not exist and mandates candidate-set encoding instead. **Ruling 4.**
T20: does not address the `runTesting` call site at `test-runner.ts:336`. **Ruling 5.**
T28: references five fixture helpers it never defines. **Ruling 6.**

## Rulings (pre-flight)

Ruling 1: The gate must carry forward stored non-terminal decisions whose `command`/`run`
scope matches the context, even when no provider produced them. — As written, T11 builds
`live` only from provider candidates, so agent-raised decisions (T12) would never be emitted
and T21's run-scoped test could not pass. Stored decisions with no current candidate keep
their stored fingerprint and are superseded only by explicit `decision revise`, which matches
spec §4 ("agent-authored decisions cannot be recomputed"). — Cost if wrong: agent-authored
questions are invisible to commands; caught immediately by T12/T21 tests.

Ruling 2: Add an optional `handler` (string) property to `decision.schema.yaml` (T1),
persist it in `materialize` (T11), and resolve apply handlers via `handlers.get(decision.handler)`
rather than via the transient candidate map. When no handler is registered and
`effect === "record-only"`, transition ANSWERED → APPLIED with `applied_changes: []`; for any
other effect, leave ANSWERED and record a problem. — Without this, an answered agent-authored
decision never reaches APPLIED and is re-emitted forever. — Cost if wrong: one extra optional
schema field; trivially reversible.

Ruling 3: In T11's test "does not persist when persist is false", replace
`assert.throws(() => rmSync(...))` with
`assert.equal(existsSync(join(project, ".paved/decisions")), false)`. — `rmSync` with
`recursive: true` is idempotent and does not throw on a missing path, so the assertion as
written can never fail and proves nothing. — Cost if wrong: none; the replacement is strictly
stronger.

Ruling 4: In T16, the prose supersedes the code block — `answeredProviders` reads the
capability id from the decision's `fingerprint.inputs` `candidate:` entries, never from a
non-existent `decision.capability` field. Build `capabilityHandler` (`effect: "record-only"`)
in T16 alongside the provider, as the plan's own self-review requires. — Cost if wrong:
capability answers do not feed resolution; caught by T16's round-trip test.

Ruling 5: T20 must also update `runTesting` (`cli/lib/test-runner.ts:336`), which reads
`selected.code`/`selected.message` — fields the new `ambiguous` variant does not carry.
Narrow on `status === "unavailable"` there and treat `ambiguous` as a separate branch. —
Cost if wrong: typecheck failure, caught immediately.

Ruling 6: T28's implementer writes the five fixture helpers it references
(`projectAwaitingFreeTextDecision`, `projectWithNoTestingTool`, `projectWithTamperedLock`,
`cleanProject`, `projectWithSecretInBuildFile`) following the fixture patterns already in the
touched suites. — The plan names them without defining them. — Cost if wrong: T28 cannot
compile; caught immediately.

Deferred minor (pre-flight): `status` will call `inspectConsumer` twice after T19
(once directly, once via `discoverAgentCommands`). Correct but wasteful; triage at final review.

## Progress

Task 1: implementer DONE, commit 2439db6 (schema, tests, fixtures, KIND_TO_SCHEMA, manifest schemas map).
Task 1: controller verification — implementer's report contained TWO false claims:
  (a) "full suite 580/580 pass" — actual is 580 tests, 578 pass, 2 FAIL.
  (b) "plugins/paved is only touched by dedicated release commits" — false; feature commits
      77e7b97 and 450ee1a both regenerated all four plugin files including the .tgz.
  Failing: "generated plugin > is exactly what the build produces from the current Core" and
  "refuses to overwrite a hand-edited generated file and replaces untouched ones".
  Cause: adding schemas/decision.schema.yaml makes the checked-in packaged plugin stale.
  Fix is `npm run build:plugin` + commit of 4 files — verified to produce exactly the same
  file set prior feature commits changed.

BLOCKER (environment, not plan): git-dlp `ZippedFilePolicy` hook (core.hooksPath =
/usr/local/git-dlp/hooks) blocks committing plugins/paved/runtime/paved-core-1.1.0.tgz.
The hook's own output states "never bypass this hook". Sanctioned path is
`nu gitdlp exempt <path> <policy> <justification>`, an org-policy action outside this
worktree. Partial commit of the other 3 files is NOT viable: provenance.json records the
tgz content_sha256, so committing it without the tgz is strictly worse.
Escalated to human partner — security-sensitive + out-of-worktree side effect.

HUMAN DIRECTIVE (not my ruling): proceed with known plugin drift; the human handles the
packaged plugin at the end. Therefore:
  NEW BRANCH BASELINE from 2439db6 onward = 2 expected failures, both plugin-packaging:
    - "generated plugin > is exactly what the build produces from the current Core"
    - "refuses to overwrite a hand-edited generated file and replaces untouched ones"
  Every later task inherits this baseline. A task is green if it adds no failure BEYOND
  these two. Plugin regeneration is deferred to the end of the run; plan Task 25 Step 5 and
  Task 29 Step 2 (`npm run check:plugin`) cannot pass in-branch and are deferred with it.
  Acceptance criteria "plugin drift check passes" / "clean-room plugin tests pass" are
  therefore NOT met in-branch by human direction, and must be surfaced at finish.

Task 1: review — Spec ✅, Quality Approved. 3 Important, 2 Minor. Adjudication:
Ruling 7: FIX the inlined sha256 patterns (decision.schema.yaml evidence item + fingerprint)
to `$ref: "urn:paved:schema:common:v1#/$defs/sha256"`. — The brief's literal text mandated
the inline pattern, but the Global Constraint says schemas must follow existing conventions
exactly, and the spec is the binding authority over the plan's text. Verified: the $def
exists at common.schema.yaml:315 and 6 schemas already use it. 28 tasks build on this
schema, so divergence would propagate. — Cost if wrong: two-line revert.
Ruling 8: FIX by adding regression tests for the 3 uncovered allOf branches (scope:run →
run required; APPLIED → applied_at required; SUPERSEDED → superseded_reason required). —
The reviewer verified all 5 conditionals are currently non-vacuous, but nothing would catch
a future regression that made one vacuous, and a silently vacuous conditional on the
foundation schema is exactly the failure 28 dependent tasks cannot see. — Cost if wrong:
three extra tests.
Ruling 9: PARK the `location` vs `fileRef.path` naming divergence (Minor). — Harmonizing now
would contradict plan Tasks 11, 14, 15, 17, 22, 23 and the spec, all written against
`location`. — Cost if wrong: cosmetic naming inconsistency with common.schema.yaml.
Ruling 10: Report-accuracy finding (Important 1) requires no code change — it is a defect in
the implementer's report, already recorded above. No loop item.
Minor (deferred): `answer: {}` unconstrained — deliberate; answer shape varies by
required_answer.type and is enforced by validateAnswer (Task 4), not by the schema.
Task 1: fix round 1/5 (2 addressed, 0 open; commits 2439db6..b364fe9).
  Controller-verified: 583 tests, 581 pass, 2 fail — both known plugin baseline. Tree clean.
  Re-review: Finding 1 ADDRESSED (decision.schema.yaml:64,113). Finding 2 ADDRESSED (a,b,c
  each isolated — re-reviewer traced that every new test fails only via its own conditional).
  New breakage: none.
Task 1: complete (commits b3e49c4..b364fe9, review clean)
Task 2: implementer DONE, commit 83b11b3 (record.ts types, decisionId, state machine; +7 tests).
  Controller-verified: 590 tests, 588 pass, 2 fail (known plugin baseline); typecheck clean;
  tree clean. Report numbers accurate. Review dispatched (BASE b364fe9).
Task 2: review — Spec ✅, Quality Approved, 0 Critical, 1 Important, 2 Minor. Reviewer
  verified all 34 schema properties and the exact 19-required/15-optional split match.
Ruling 11: FIX — define `EffectClass` (the schema's six effectClass values) in
  cli/lib/decisions/record.ts alongside the other enums, and type `Decision.effect` as
  `EffectClass` instead of bare `string`. — The brief mandated `string`, but every other
  enum-backed field got a literal union, and 27 tasks inherit this. EffectClass must live in
  record.ts, NOT effects.ts: Task 5's effects.ts already imports AnswerChannel/
  DecisionRisk/DecisionReversibility from record.ts, so defining it there instead would
  create an import cycle. CARRY INTO TASK 5: effects.ts imports EffectClass from record.ts
  and may re-export it; it must not define its own. — Cost if wrong: one type moves; the
  cycle risk is the real reason for the placement.
Ruling 12: PARK both Minors (mid-file import statement in record.test.ts:95; `as never`
  casts at record.test.ts:131,137 that skip compile-time proof the fixture satisfies
  Decision). Both verbatim from the brief, test-only, and schema-validation tests already
  cover object shape at runtime. — Cost if wrong: cosmetic lint noise; no runtime effect.
Task 2: fix round 1/5 (1 addressed pending re-review, 0 open; commits e18ebba..31e66c4).
  Controller-verified: 591 tests, 589 pass, 2 fail (known plugin baseline). New commit
  authored as &lt;requested-address&gt; — confirms repo-local identity propagates to
  subagent commits without per-dispatch instructions.
  Re-review: finding ADDRESSED (a,b,c), placement HELD, no new breakage. BUT test-strength
  assessment: the new test never references the TS type — it loops a hand-written literal
  array through schema validation, so it catches divergence in NEITHER direction.
Ruling 13: OPEN a second fix round rather than accept it. — The requirement I wrote was
  "keeps the TypeScript union and the schema enum honest with each other"; a test that
  cannot fail when they diverge does not meet it, whatever its surface shape. Generalizing
  to ALL SEVEN enum-backed fields (DecisionStatus, DecisionCategory, DecisionAuthor,
  AnswerSource, AnswerChannel, DecisionRisk, DecisionReversibility, RequiredAnswerType,
  EffectClass) because the mechanism and the exposure are identical, and record.ts is the
  foundation 27 tasks import. Both directions must be covered: an exhaustive
  `Record<Union, true>` forces TS→schema, and reading the schema's enum at test time forces
  schema→TS. — Cost if wrong: one extra test file of ~40 lines; round 2 of 5, cap intact.
Task 2: fix round 2/5 (1 addressed, 1 new finding; commits 31e66c4..a3d787a).
  Controller-verified: 599 tests, 597 pass, 2 fail (known plugin baseline). Controller also
  read enum-parity.test.ts directly: 9 exhaustive Record<Union,true> maps + schema parsed
  from real YAML. Re-review confirmed both directions ADDRESSED and walked all 9 schema
  paths against the file.
Ruling 14: OPEN round 3 to restore the deleted end-to-end test. — The re-review found the
  removal was NOT redundant: the old test ran effect values through registry().validate(),
  exercising properties.effect's `$ref: "#/$defs/effectClass"` through the real validation
  pipeline. The parity test reads $defs.effectClass.enum directly and never touches
  properties.effect, so a broken/mistyped $ref would leave `effect` unconstrained at
  validation time while parity still passed — reintroducing precisely the Important finding
  round 1 fixed. Reviewer grepped and confirmed no other test covers it. — Cost if wrong:
  one restored ~6-line test; round 3 of 5, cap intact.
  Bundling the Minor `.sort()` fix (mutates the shared module-scoped parsed schema in all 9
  tests; latent order-dependence, not a live defect) into the same dispatch — no extra round.
Task 2: fix round 3/5 (2 addressed, 0 open; commits a3d787a..121f20e).
  Controller-verified: 601 tests, 599 pass, 2 fail (known plugin baseline); typecheck clean;
  all 9 sort calls copy before sorting. Re-review confirmed the negative effect test is
  genuinely falsifiable by a broken $ref (additionalProperties:false, no allOf conditional
  references effect, fixture otherwise valid), not passing for an unrelated reason.
Task 2: complete (commits e18ebba..121f20e, review clean)
  Net gain over plan spec: record.ts is the module 27 tasks import, and it now has
  compile-time + runtime parity guards across all 9 enums plus end-to-end $ref coverage that
  the plan never specified.
Task 3: implementer DONE, commit a6dca24 (fingerprint.ts: fingerprintOf/isStale/supersede;
  tests/decisions/invalidation.test.ts, +9 tests).
  Controller-verified: 610 tests, 608 pass, 2 fail (known plugin baseline); tree clean;
  authored as &lt;requested-address&gt;. Review dispatched (BASE 121f20e).
Task 3: review — Spec ✅, Quality Approved, 0 Critical, 1 Important, 3 Minor.
Ruling 15: FIX the vacuous narrowness test. — PLAN DEFECT, not implementer error: the test
  was copied verbatim from task-3-brief.md lines 56-63, i.e. from the plan I wrote. It calls
  fingerprintOf(evidence, ["a"]) vs fingerprintOf([...evidence], ["a"]) — identical content,
  shallow-copied array — so it proves determinism only and would pass even if fingerprintOf
  hashed the whole repo tree. Narrowness is the single most important property of this
  module; a test that claims to prove it but cannot fail is worse than no test because it
  manufactures false confidence. Rename it to what it actually tests, and add a genuine
  behavioural narrowness test at the isStale level: a decision citing pom.xml must NOT be
  stale when an uncited file changed but its own cited evidence did not. — Cost if wrong:
  one renamed + one added test.
Ruling 16: FIX all three Minors in the same dispatch (no extra round) — they are genuine
  untested branches, each ~4 lines: evidence-order independence (only candidate order is
  tested); isStale on PENDING and ANSWERED (untested branches); supersede throwing on an
  already-terminal decision, which is the entire stated justification for routing through
  transition() rather than hand-constructing the record. — Cost if wrong: three small tests.
Task 3: fix round 1/5 (4 addressed, 0 open; commits a6dca24..b14f385, tests only —
  fingerprint.ts deliberately untouched and confirmed unchanged in the diff).
  Controller-verified: 620 tests, 618 pass, 2 fail (known plugin baseline); 19/19 in
  invalidation.test.ts. Controller also read the narrowness pair directly.
Task 3: complete (commits 121f20e..b14f385, review clean)
PRECISION NOTE for the final report — do NOT over-claim: narrowness is a property of
  `fingerprintOf`'s SIGNATURE (it receives only evidence + candidates and cannot read the
  tree, clock, or decision state). No runtime test can prove it in general: a broad
  implementation called twice in one process against unchanged hidden inputs yields matching
  digests and is indistinguishable. The tests prove the OBSERVABLE CONTRACT (cited-changed →
  stale; cited-unchanged → not stale). Both the controller and the re-reviewer reached this
  independently. The implementer's report claims these tests "form the complete narrowness
  property" — that overstates it. Describe it accurately at finish.
Task 4: implementer DONE, commit 2147f85 (answers.ts: parseAnswerFlags/validateAnswer/
  assertAnswerIdentity/AnswerIdentityError; tests/decisions/answers.test.ts, +17 tests).
  Controller-verified: 637 tests, 635 pass, 2 fail (known plugin baseline).
  Controller security audit of answers.ts: no process.env, no git user.email call, no
  execSync/spawnSync, no comma splitting. Only textual match was the explanatory comment at
  line 83. Both security rules hold on direct inspection. Review dispatched (BASE b14f385).
Task 4: review — Spec ✅, Quality Approved, 0 Critical, 0 Important, 2 Minor. No fix round
  (Minors never enter the loop). Reviewer independently confirmed BOTH security rules
  UPHELD, and went past the controller's grep: answers.ts's only import is type-only and
  erased at runtime, and record.ts has no side-effecting imports — so no ambient reach even
  indirectly.
Task 4: complete (commits b14f385..2147f85, review clean)
Task 4: minor (deferred): validateAnswer relies on implicit fallthrough to the free-text
  branch rather than an explicit `default: throw`. Safe today — RequiredAnswerType is a
  closed 4-member union — but a 5th type would be silently validated as free-text with no
  compiler error inside the function. Triage at final review.
Task 4: minor (deferred): answers.ts:76 compiles `new RegExp(decision.required_answer
  .pattern)`. Correctly out of scope here, but see the CARRIED FINDING below.

!! CARRIED FINDING FOR TASK 12 (`paved decision raise`) !!
An agent-authored decision supplies `required_answer.pattern`, which Task 4 compiles with
`new RegExp(...)` and runs against a user-supplied answer. A catastrophic-backtracking
pattern from a buggy or hostile agent is a ReDoS vector that hangs the CLI. This is exactly
the class spec Phase 22 covers ("questions must never be used to bypass security"), and
Task 4's brief correctly did not address it — the trust boundary belongs where decisions are
CREATED, not where answers are validated. Decide at Task 12. Leading option: forbid
agent-raised decisions from setting `pattern` at all (simplest, no regex analysis needed);
fallbacks are a length cap plus a nested-quantifier reject. Do not let Task 12 ship without
ruling on this.

Task 5: implementer DONE, commit 4007de0 (effects.ts: EffectTier/EFFECT_TIERS/
  AGENT_ASSIGNABLE_EFFECTS/tierFor + EffectClass re-export; tests/decisions/security.test.ts
  created, +6 tests).
  Ruling 11 applied successfully: the brief's Step 3 defined EffectClass locally, which
  would have cycled with record.ts; dispatch overrode it to import type-only and re-export.
  Controller-verified: 643 tests, 641 pass, 2 fail (known plugin baseline); typecheck clean
  (this is what proves no cycle); `export type EffectClass` appears ONLY at record.ts:11;
  AGENT_ASSIGNABLE_EFFECTS = {record-only}. Review dispatched (BASE 2147f85).
Task 5: review — Spec ✅, Quality Approved, 0 Critical, 3 Important, 2 Minor. All three
  security invariants UPHELD in shipped code (reviewer checked EFFECT_TIERS entry by entry,
  not just the rows the tests sample).
Ruling 17: FIX all three Importants. — (1) EFFECT_TIERS has no Object.freeze, so `readonly`
  is compile-time only and erased at runtime. (2) tierFor returns the LIVE singleton on the
  non-planApproval path, so a caller mutating what it received corrupts the canonical table
  process-wide — every later destructive decision would route `relayed`. (3) The
  AGENT_ASSIGNABLE_EFFECTS test spot-checks membership instead of asserting set equality, so
  adding `config-additive` later would pass silently while violating the stated invariant.
  This module is explicitly a security control, the fixes are a few lines, and there are
  currently zero external consumers — cheapest possible moment to harden it. — Cost if
  wrong: freeze could surface a latent mutation elsewhere, but there are no consumers yet.
Ruling 18: Bundle both Minors into the same round (no extra round), and UPGRADE the second.
  Minor A: planApproval override is only tested on a relayed-base effect; extend across
  tiers. Minor B (upgraded): tierFor does not validate `effect`. Today an unknown value
  throws downstream on `.channel`. But Ruling 17's `return { ...tier }` would turn that into
  a SILENT malformed `{}` — strictly worse than crashing. So the copy fix REQUIRES an
  explicit throw on unknown effect; they must ship together or not at all.
Task 5: fix round 1/5 (5 items applied; commits 4007de0..e8dc307).
  Controller-verified: 645 tests, 643 pass, 2 fail (known plugin baseline). Implementation
  correct on inspection: both freeze levels present, unknown-effect guard present, copy
  returned on both paths.
Ruling 19: OPEN round 2 — the freeze is untested and the implementer's evidence for it is
  wrong. The test "prevents mutations of the returned tier from affecting the canonical
  singleton" mutates the COPY that tierFor now returns, so it proves the copy isolates, not
  that the table is frozen; deleting Object.freeze entirely would leave it green. The
  implementer reported "frozen-object assignment silently fails — no error thrown", which is
  false: the assignment SUCCEEDED on an unfrozen copy. Controller verified empirically with
  `node --input-type=module`: assigning to a frozen property in ES-module strict mode throws
  TypeError. Two protections exist (freeze, copy); only one is covered. — Cost if wrong:
  two ~3-line tests. This is the fourth instance in this plan of a test whose name claims
  more than its body proves (Tasks 2, 3, 5-r1, 5-r2) — pattern worth naming at finish.
Task 5: fix round 2/5 (freeze coverage added; commits e8dc307..3663244).
  Controller-verified: 647 tests, 645 pass, 2 fail (known plugin baseline); both freeze
  tests present and throwing TypeError. Implementer acknowledged its false "silently fails"
  claim.
PROCESS DEVIATION (controller, recorded deliberately): I opened round 2 directly off my own
  inspection of round 1's report, without first dispatching round 1's scoped re-review. The
  protocol is one fix dispatch + one scoped re-review per round. To avoid leaving round 1
  unreviewed I dispatched ONE combined re-review over the full fix range 4007de0..3663244
  (3 commits) verdicting all six findings from both rounds. Nothing ships unreviewed, but
  the round accounting is 2 dispatches / 1 re-review rather than 2/2.
Task 5: combined re-review — all 6 findings ADDRESSED, no regression across the 5 original
  security invariants, no new breakage. Reviewer confirmed the frozen object IS the exported
  one (same reference, Readonly<> is a type-level alias only), and that the three
  immutability tests are independently falsifiable: copy test survives deleting both
  freezes; freeze-entry test fails if only the per-entry loop is removed; freeze-add-key
  test fails if only the outer freeze is removed. Commit 3663244 is a one-character `!`
  required by noUncheckedIndexedAccess — compile-time only, masks nothing, weakens nothing.
Task 5: complete (commits 2147f85..3663244, review clean)
  Net gain over plan spec: EFFECT_TIERS is now runtime-immutable and tierFor validates its
  input and copies on every path — none of which the plan specified, and all of which matter
  because this module is the control that stops a destructive decision taking the weak
  channel.

Task 6: implementer DONE, commit e305112 (store.ts + tests/decisions/persistence.test.ts
  + two manifest consumer_layout entries). Controller-verified: 654 tests, 652 pass, 2 fail
  (known plugin baseline); manifest diff purely additive, no existing entry touched.
  Reviewer confirmed NO manifest/boundaries assertion was weakened — neither suite
  enumerates consumer_layout paths, so both passed unmodified.
Task 6: review — Spec ✅, Quality Approved, 0 Critical, 2 Important, 3 Minor.
  Id-guard ordering CORRECT and the two hostile-input tests pass for the RIGHT reason:
  resolveSafePath throws plain Error, the tests assert DecisionStoreError specifically, so
  they can only pass if the id guard rejected first. Verified non-vacuous.
Ruling 20: FIX the read-side validation gap, by changing the signature now. — PLAN DEFECT:
  I specified `readDecision(projectRoot, id)` with no `coreRoot`, which structurally cannot
  call createRegistry — so the store validates on write and trusts blindly on read, for a
  file class manifest.yaml itself declares `committed: true` (git-tracked, human-editable,
  reachable on every checkout). The reviewer found the codebase's own precedent: workflow.ts
  `approval()` validates the sibling committed .paved/approvals/<run-id>.json field by field
  before trusting it. Decision files carry comparably sensitive fields (status, answered_by,
  answer_channel, answer_source) that the schema itself annotates as never-caller-supplied.
  Schema validation on read DOES close the forged `answered_by: agent` case, because the
  schema already carries `not: {enum: [agent, paved, ci]}`. Doing this NOW costs almost
  nothing — there are zero consumers yet; deferring means changing call sites in Tasks 11,
  12 and 19 later. — Cost if wrong: a coreRoot parameter threaded through three call sites
  that do not exist yet.
  !! CARRY INTO TASKS 11, 12, 19: readDecision/listDecisions take (projectRoot, coreRoot, ...) !!
Ruling 21: FIX the vacuous listDecisions ordering test (5th instance of this pattern). The
  fixture uses ids d-aaa…/d-bbb… created 00:01/00:02, so alphabetical and chronological
  order coincide — the test would pass if the sort ignored created_at entirely, or returned
  readdir order. Requires an id pair whose alphabetical order is the REVERSE of creation
  order. — Cost if wrong: one fixture change.
Ruling 22: Bundle Minors 4 and 5 (untested listDecisions filtering of non-.yaml and
  non-id filenames; write-rejection test does not assert absence of a partial file) into the
  same round — no extra round. DEFER Minor 3 (createRegistry recompiled per write, ~20
  schemas each call) — real but a performance concern with no consumers yet; triage at final
  review.
Task 6: fix round 1/5 (4 addressed, 0 open; commits e305112..c0dc990).
  Controller-verified: 657 tests, 655 pass, 2 fail (known plugin baseline); signatures now
  carry coreRoot; ordering fixture genuinely reversed.
  Re-review: all findings ADDRESSED. Corrupt vs absent correctly distinguished — existsSync
  early-return precedes parse/validate, two structurally separate branches, cannot be
  conflated. readDecision now applies rigour comparable to workflow.ts approval(); the only
  check schema validation cannot replicate is approval()'s cross-record plan-digest
  tie-back, which is inherently outside a single-document validator and not in scope here.
  No test weakened or deleted; decisionPath id guard not regressed; no callers elsewhere.
Task 6: complete (commits 3663244..c0dc990, review clean)

!! CARRIED DESIGN NOTE FOR TASKS 11 AND 19 — listDecisions is now fail-closed !!
Because listDecisions validates every file through readDecision, ONE corrupt or tampered
decision makes it throw and abort listing ALL others, rather than skipping the bad one.
The re-reviewer correctly classed this as the intended consequence of Ruling 20, not a
regression — so no fix round. But the consumer semantics are genuinely undecided:
  - Task 11 (gate): fail-closed is RIGHT. Silently skipping a corrupt decision while
    applying answers is exactly the tampering path Ruling 20 closed.
  - Task 19 (status): fail-closed is probably WRONG. status is read-only and diagnostic;
    one corrupt file should surface AS a diagnostic, not make the command unusable at
    precisely the moment the user needs it to diagnose. Task 19 should catch
    DecisionStoreError and convert it to a diagnostic rather than propagating.
Decide explicitly in each task; do not let either inherit the default silently.

Task 7: implementer DONE, commit 48f2e7a (result.ts: awaiting_input status, exit code 10,
  DecisionProjection, top-level decisions, the new invariant, primaryCategory short-circuit;
  tests/cli/decisions.test.ts +7 tests).
  Controller-verified across 4 runs: 664 tests, 662 pass, 2 fail (known plugin baseline);
  typecheck clean.
  Two EXISTING test files modified, both scrutinised:
    - synthetic-agent.test.ts: Result status union widened — expected, brief called it out.
    - cli/cli.test.ts: `ExitCategory[]` → `("success" | DiagnosticCategory)[]`, unused
      import dropped. Controller analysis: pre-Task-7 ExitCategory had 10 members and
      DiagnosticCategory was Exclude<…,"success">; post-Task-7 DiagnosticCategory is
      Exclude<…,"success"|"awaiting-input"> and is STILL 9. So ("success" |
      DiagnosticCategory) === the old 10-member ExitCategory. Faithful restatement, not a
      loosening. Reviewer asked to confirm independently AND to establish why the original
      annotation stopped compiling — if the real cause differs, the fix may be papering
      over something.

!! FLAKE OBSERVED ONCE — UNIDENTIFIED !!
One run reported `ℹ fail 3` where every other run reports `fail 2`. I could not identify
the third failure: I had run the count and the failure names as two SEPARATE `npm test`
invocations, so the names belonged to a different run. Four subsequent runs (including
three consecutive) all report exactly 2. Methodology fix adopted: always capture counts and
names from ONE run into a single log file. If this recurs, identify it immediately — an
intermittent failure in a 664-test suite would make every later task's verification
ambiguous, which is worse than the plugin baseline because it is nondeterministic.
  Task 7 reviewer found nothing in that diff capable of causing order-dependence or shared
  state leakage — result.ts has no module-level mutable state and the new tests are
  synchronous independent literals. So the flake's cause lies elsewhere in the suite.

Task 7: review — Spec ✅, Quality Approved, 0 Critical, 0 Important, 3 Minor. No fix round.
  Invariant CANNOT be bypassed: enforcement is inside createResult, and no other file in
  cli/ or integrations/ references awaiting_input at all yet. Recursion terminates — the
  recursive call sets status:"failed", which cannot re-enter the awaiting_input guard, so
  at most one extra call; and the injected internal-category diagnostic makes
  hasBlockingDiagnostic true so the malformed-failure branch is correctly skipped, no
  duplicate diagnostic.
  Naming asymmetry preserved with no cross-contamination: awaiting_input (underscore) only
  on ResultStatus, awaiting-input (hyphen) only on ExitCategory/EXIT_CODES/precedence.
  cli/cli.test.ts change CONFIRMED a faithful restatement, independently derived: the old
  `ExitCategory[]` annotation broke because narrowing past "success" yields a 10-member
  type that is not assignable to the now-9-member DiagnosticCategory parameter of
  createDiagnostic. Still 6 commands × 10 categories = 60 assertions, none dropped.
Task 7: complete (commits c0dc990..48f2e7a, review clean)
Task 7: minor (deferred): the "refuses awaiting_input without a required decision" test
  only exercises `decisions: []`, never a NON-EMPTY array where every entry is
  required:false. Same code path, untested branch shape.
Task 7: minor (deferred): a `failed` result can still carry an unresolved required:true
  decision, because the conditional spread checks decisions.length and not status. Not a
  spec violation — decisions may ride along with any status — but worth a doc note.
Task 7: minor (NOT deferred — it is Task 8's job): renderHuman has no decisions rendering,
  so a human-mode awaiting_input result would print no question text. Correctly out of
  scope for Task 7; Task 8 implements exactly this.

Task 8: implementer DONE, commit d273ca7 (cli/output.ts renderDecision/renderDecisions +
  renderHuman integration; tests/cli/decisions.test.ts +4 tests).
  Controller-verified (single run): 668 tests, 666 pass, 2 fail (known plugin baseline).
  Implementer correctly kept the brief's wording verbatim and FLAGGED the inaccuracy rather
  than deviating unilaterally — the right behaviour; a silent "fix" would have been harder
  to detect than a reported one.
Task 8: review — Spec ✅, Quality Approved, 0 Critical, 3 Important, 4 Minor.
Ruling 23: FIX the false "irreversible" claim — and take the REVIEWER'S wording over mine.
  I proposed deriving the text from `reversibility`. The reviewer argued the renderer
  should not assert reversibility at all, only what the channel value actually guarantees
  ("a person must approve it"). That is true for every path into human-authored
  (repository-mutating, destructive, AND any planApproval-forced case) and avoids a
  three-way branch for a claim the renderer has no need to make. Better than my version;
  adopting it. Confirmed reachable: tierFor("record-only", {planApproval:true}) yields
  reversibility:"reversible" + channel:"human-authored", asserted at security.test.ts:23.
  Latent today (tierFor has no callers outside its own module) but goes live the moment a
  later task wires plan-approval decisions through this renderer. — Cost if wrong: one
  string.
Ruling 24: FIX the vacuous recommendation test — SIXTH instance of this pattern in this
  plan. The fixture has exactly ONE option, so `option.id === decision.recommended` is
  trivially true and the test passes even if the option-marking logic is deleted or marks
  the wrong option. Needs ≥2 options and an assertion that the marker lands on the right
  one. — Cost if wrong: one fixture.
Ruling 25: FIX the untested runId branch. Repo-wide grep confirms NO test anywhere sets
  runId on a DecisionProjection, so both the `--run <id>` formatting and the "absent runId
  must not emit `--run undefined`" guarantee rest on manual inspection only. — Cost if
  wrong: two small tests.
Ruling 26: Bundle Minors 4, 5, 6 into the same round (no extra round): negative assertion
  that human-authored emits no `--answer`/`Resume:` line; a multi-decision result covering
  heading pluralisation and block separation; and isolating the optional label so it cannot
  be satisfied by the heading text. DEFER Minor 7 (renderDecisions exported but only
  exercised transitively) — harmless, equivalent coverage.
Task 8: fix round 1/5 (6 items applied; commits d273ca7..c04adf4).
  Controller-verified (single run): 672 tests, 670 pass, 2 fail (known plugin baseline);
  output.ts:64 no longer claims irreversibility.
Ruling 27: DEFER the block-separator finding. The implementer reported — as instructed,
  rather than asserting around it — that consecutive decision blocks join with a single
  `\n` and render adjacent with no blank line. Genuinely cosmetic: each block still carries
  its own `[id]` prefix and indentation. Counter-argument considered and rejected: batching
  IS a headline feature of this plan, so multi-decision output is the showcase path, not an
  edge case — but a fix round plus re-review for one blank line is poor allocation with 21
  tasks remaining, and deferred-minor triage at final review is the designed mechanism for
  exactly this. — Cost if wrong: slightly cramped output on the batched-questions path
  until final-review triage. DO NOT let this be dropped silently at finish.
Task 8: re-review — all 6 findings ADDRESSED, no new breakage. Recommendation test verified
  by trace to fail on MISPLACEMENT, not merely deletion (both the missing-marker and
  wrongly-present-marker assertions fire independently) — so the degenerate-fixture shape
  that caused the original defect is genuinely gone, not reproduced in a subtler form.
  Implementer's audit claim CONFIRMED by independent walk of every emitted line: only the
  irreversibility sentence overstated the projection; `risk` is never surfaced at all.
  Actionability preserved — the reworded text still names .paved/approvals/<id>.json.
Task 8: complete (commits 48f2e7a..c04adf4, review clean)

