# Skill evaluation and context efficiency

## Goal

Measure whether Paved's Claude plugin routes representative requests to the right skills, avoids unnecessary skill activation, and improves answer quality, then use that evidence to reduce always-on and on-invocation context without weakening skill behavior.

## Current evidence

- Paved Core already defines progressive disclosure and keeps each skill's supporting material in referenced files, but it has no model-backed skill behavior benchmark.
- The generated Claude plugin has 30 skills. `claude plugin details paved@paved` reports an estimated 2,638 always-on tokens for the installed Paved 2.0.0 plugin; this is not the 2.1.0 worktree build and is not a measured per-task token count.
- Several high-use skills are near the current 150-line ceiling: `task-specification` (134 lines), `task-review` (127), and `change-review` (128). Their bodies are 1,000–1,335 words.
- Claude Code 2.1.289 provides `claude plugin eval`, which runs realistic prompts in isolated sessions, scores graders, and can compare a plugin arm with a no-plugin arm. Each eval run and model-based grader consumes account usage.
- The Apecatus Integration checkout has pre-existing local changes and is not initialized with Paved. It is an external, local-only validation target; the evaluation must not edit it or include its domain-specific code in Paved Core.

## Design

### 1. Reusable Claude evaluation suite

Author a small, domain-neutral suite alongside the Claude plugin build inputs. The plugin builder projects these cases into the generated Claude plugin so the native `claude plugin eval` command can run them against the exact locally built plugin. Evaluation results stay outside generated plugin outputs by passing an explicit temporary output directory.

The first suite covers:

- A request that should invoke one named Paved skill from natural language.
- A nearby request that should not invoke that skill.
- A simple repository question that should be answered directly without starting a change workflow.
- A change request where Paved's workflow guidance should be used.
- A deliberately ambiguous request where the response should ask for the missing decision rather than guess.
- A long-context review request where the relevant skill should be selected and unnecessary references should not be loaded.

Cases use synthetic repositories or self-contained prompts. No case contains Apecatus business behavior, credentials, or private files. Deterministic transcript graders check skill invocation and tool order; short LLM graders judge the user-visible outcome with concrete pass/fail criteria. The standard comparison reports scores with Paved and without Paved. Token and cost figures are recorded only when Claude's eval output exposes them; plugin component token estimates are recorded separately.

### 2. Before/after skill revision

Capture the baseline suite and Claude plugin component-cost report from the generated 2.1.0 Core plugin before changing skill content. Revise descriptions for all 30 projected skills to state a specific user goal and a narrow activation condition. Review bodies against the benchmark; shorten only where concrete procedure, references, examples, or duplicated instructions can move out of the body loaded on invocation without losing required steps.

Each changed skill keeps its existing purpose and Paved contract. Supporting files remain one level deep and listed in `skill.yaml`. Any semantic change bumps that skill's version; wording-only changes follow the existing skill versioning rules. Generated plugin directories are rebuilt from canonical sources.

Run the same cases and cost report after the revisions. Report absolute scores, plugin contribution against the no-plugin arm, false activations, skill invocation rates, component token estimates, and model-reported usage where available. Do not claim token savings from word counts alone.

### 3. Apecatus local validation

Use the user-approved Apecatus repository in a Claude Code session with the local generated Paved plugin. Restrict the validation prompts to read-only repository questions and skill-routing probes; grant no write tools. Record Claude version, Paved plugin/runtime version, prompt, selected skill or workflow, response outcome, and token usage when exposed. Do not initialize Paved, write `.paved/`, edit existing local changes, or persist Apecatus content in the Paved repository.

This local validation complements the reusable suite. It is not a portable benchmark result because the checkout contains uncommitted user state and the plugin eval runner starts each case in its own workspace.

## Success criteria

- The Claude eval suite runs against the local generated plugin and produces a with-plugin/no-plugin report.
- Positive routing cases invoke their intended skill; negative routing cases do not invoke the targeted skill or start an unnecessary workflow.
- The revised suite does not regress the mean user-outcome score or the Paved contribution score; any case regression is explained and corrected before adopting the revision.
- Claude's component estimate shows a lower always-on cost or documents why it cannot be reduced without harming skill discovery. Per-skill on-invocation estimates are compared for revised skills.
- Apecatus probes run with read-only tools and leave its existing working tree unchanged.
- The generated Claude plugin matches its canonical sources and the Core's `npm run check` passes.

## Constraints

- Keep the Core domain-agnostic; Apecatus is not a committed fixture.
- Preserve Claude's existing user authorization, workflow gates, and Paved ownership behavior.
- Keep evaluation prompts and graders out of plugin runtime context; keep skill support material on demand rather than always-on.
- Bound paid evaluation runs with explicit case filters, run counts, and a CLI cost ceiling where supported.
- Do not store account tokens, user data, or eval transcripts in tracked results.

## Risks and mitigations

- Model and grader variation can make a one-run score noisy. Use one-run screening to refine cases, then repeat the final suite with multiple runs and inspect grader explanations.
- A grader may reward a particular phrase instead of correct behavior. Pair outcome graders with transcript graders and use concrete pass/fail criteria.
- A skill may appear costlier after moving text to references if the model opens those references frequently. Compare both always-on and per-skill invocation estimates and inspect the session trace.
- Apecatus state can change between local probes. Record the repository revision and dirty-state summary without capturing diff contents.

## Out of scope

- Adding multi-agent orchestration or cross-session handoff behavior.
- Changing Core workflow phases, CLI command contracts, schemas, or adapter behavior.
- Automatically changing skill versions, user project state, or global Claude plugin installation.
- Treating static word counts or the installed Paved 2.0.0 token estimate as the 2.1.0 model-backed baseline.
