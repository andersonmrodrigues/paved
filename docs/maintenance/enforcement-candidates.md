# Enforcement candidates

Architectural rules of the Core and where each one is enforced. Principle 3 applies to
the Core itself: a rule that is only documented is a candidate for a check. Status:

- **Enforced:** a test in this repository fails when the rule is broken.
- **Schema:** a consumer document that breaks it is rejected by its schema.
- **Planned (CLI):** specified for `paved doctor`, `update` or `verify`; not implemented.
- **Review:** only human review can catch it today.

## Core repository

| Rule | Status | Where |
|---|---|---|
| Every top-level directory is a declared component | Enforced | `tests/core/boundaries.test.ts` |
| Component graph is acyclic; distributed depends only on distributed | Enforced | `tests/core/boundaries.test.ts` |
| Markdown links and TS imports follow `depends_on` | Enforced | `tests/core/boundaries.test.ts` |
| No `project.*` / `adapter-*` ids in Core skills, workflows, rules, tools | Enforced | `tests/core/boundaries.test.ts` |
| No `project.*` ids in adapter YAML | Enforced | `tests/core/boundaries.test.ts` |
| Every schema is registered, compiles in strict mode, and maps to the library | Enforced | `tests/schemas/schemas.test.ts` |
| Every schema has valid and invalid fixtures; each invalid fixture fails for the stated reason | Enforced | `tests/schemas/schemas.test.ts` |
| Shared definitions never reference document schemas (acyclic `$ref` graph) | Enforced | `tests/schemas/schemas.test.ts` |
| `apiVersion` compatibility is checked before the schema | Enforced | `tests/schemas/schemas.test.ts` |
| Templates (YAML, and Markdown frontmatter with a `kind`) are valid documents | Enforced | `tests/schemas/schemas.test.ts` |
| Check-type enum equals the verification registry | Enforced | `tests/schemas/schemas.test.ts` |
| Core Check definitions match their paths, reference existing safe Tools and use declared inputs and bounded timeouts | Enforced | `tests/core/references.test.ts`, `tests/verification/` |
| Tool contracts declare safety, permissions, environments, typed I/O, effects and bounded execution policy; bindings match contract versions and environments | Enforced for schemas and library resolution | `tests/schemas/`, `tests/tools/tools.test.ts` |
| Tool overrides only narrow policy or select an explicit compatible binding | Enforced by override validation | `tests/tools/tools.test.ts` |
| Destructive/high-impact Tools require independent approval and cannot retry; agent discovery does not grant execution permission | Enforced by policy library; authenticated runner remains future work | `cli/lib/tools.ts`, `tests/tools/tools.test.ts` |
| Tool execution evidence is revision-bound, sanitized and cannot turn execution success alone into a passed verification check | Enforced by capture/conversion library | `tests/tools/tools.test.ts`, `tests/verification/` |
| Skill, workflow, rule and tool ids match their paths | Enforced | `tests/skills/`, `tests/workflows/`, `tests/core/rules-and-tools.test.ts` |
| Core and template references resolve and respect visibility | Enforced | `tests/core/references.test.ts` |
| Markdown templates cite only declared sources; managed blocks are well formed | Enforced | `tests/provenance/` |
| Inline generator metadata only for outputs whose schema has `provenance` | Enforced | `tests/generators/` |
| Workflows follow the canonical phase order, which equals `lifecycle.md` | Enforced | `tests/workflows/` |
| Workflows gate destructive tools, carry their change type's approval, require provable checks and do not duplicate skill activation | Enforced | `tests/workflows/` (`assessWorkflowQuality`) |
| Failure codes are documented in `instructions/workflows.md` and match the schema enum | Enforced | `tests/workflows/` |
| Run records are consistent with their workflow | Library + fixtures; planned in `paved doctor` | `assessRun` |
| Approvals are made by an authenticated person | Candidate (runner or CI integration) | |
| Generators write only `generated-reviewed` or `disposable` paths | Enforced | `tests/generators/` |
| Generator output schema matches the layout's declared schema | Enforced | `tests/generators/` |
| Only `.paved/manifest.yaml` is required; layout schemas are known kinds | Enforced | `tests/core/manifest.test.ts` |
| Override template targets exist and are overridable | Enforced | `tests/core/references.test.ts` |
| Versions agree across `VERSION`, manifest, `package.json`, changelog | Enforced | `tests/core/manifest.test.ts` |
| Relative Markdown links resolve | Enforced | `tests/core/links.test.ts` |
| Core prose is domain- and technology-agnostic | Review | A keyword scan could be added; semantic agnosticism needs a human |
| Skills: size limits, no technology names, identifiers or shell blocks, activation phrase in the description, contract fields mentioned in the body, no copied rules | Enforced | `tests/skills/` (`assessSkillQuality`) |
| Skills: acyclic dependencies, no dependency on a deprecated skill, no sentence duplicated across skills, no unproving required check | Enforced | `tests/skills/` |
| Skills: supporting files listed, present, one level deep | Enforced | `tests/skills/`, schema |
| Every context area maps to a consumer path in the layout | Enforced | `tests/core/manifest.test.ts` |
| Skills are useful and correct | Review | |
| Breaking changes are classified correctly in the changelog | Review | A schema-diff check against the last release is a candidate |

## Consumer documents

| Rule | Status | Where |
|---|---|---|
| `apiVersion` present and supported; newer and older reported distinctly | Enforced in library | `checkApiVersion` in `cli/lib/schemas.ts` |
| Inferred and observed context carries provenance | Schema | `project-context`, `feature` |
| Generated provenance has `generator_version` and `output_sha256`; sidecars never name `human` | Schema | `provenance`, `generated-artifact` |
| File sources are repository-relative; URL sources are http(s) | Schema | `provenance#/$defs/source` |
| Cited source ids are declared; managed blocks well formed with unique ids | Enforced in library | `cli/lib/provenance.ts` |
| Qualified ids have a known namespace and the segment count of their kind | Schema | `common` |
| References resolve; Core → core only, adapter → core and itself; overrides never target project content | Enforced in library | `cli/lib/references.ts` |
| `complete` evidence has no failed checks, unmet criteria, or violated `error` rules | Schema | `evidence` |
| Evidence that uses profile checks names the profile | Schema | `evidence` |
| Every observation records who observed it | Schema | `evidence` |
| Evidence claims are supported by check types that can support them | Enforced in library | `cli/lib/evidence.ts` |
| No completion while a required check is missing, blocked, skipped, failed or inconclusive | Enforced in library | `evaluateCompletion`; `tests/verification/` |
| A complete record declares `verified`; partial verification cannot claim completion | Schema + library | `schemas/evidence.schema.yaml`, `cli/lib/evidence.ts` |
| A passing exit code or measurement agrees with its Check definition | Enforced in library when definitions are supplied | `cli/lib/evidence.ts`; `tests/verification/` |
| Retry history stays bounded and disagreement remains flaky | Schema + library | `schemas/check.schema.yaml`, `cli/lib/evidence.ts` |
| Observations match the change revision | Enforced in library | `cli/lib/evidence.ts` |
| Agent-recorded reviews and manual observations support nothing | Enforced in library | `cli/lib/evidence.ts` |
| `policy.minimum_recorder` | Enforced in library | `cli/lib/evidence.ts` (the CLI must pass the profile's policy) |
| Read-only tools have no side effects; destructive tools need confirmation | Schema | `tool` |
| Skill `status`, `version` and `deprecation` agree | Schema | `skill` |
| Complete evidence satisfies its producer skills' required checks and evidence kinds | Enforced in library | `cli/lib/skills.ts` (`assessSkillEvidence`) |
| Override `set-severity` has a severity; `extend` has an addendum or changes; every entry has an owner | Schema | `override` |
| Composition: assembling the effective set, short-name collisions, duplicate overrides, no override on `overridable: false` | Planned (CLI) | `paved doctor`, `paved update` |
| Adapter names unique across categories (so `adapter-<name>` is unambiguous) | Planned | adapter registry |
| Override drift (`target_sha256`) suspends subtractive overrides | Planned (CLI) | `paved update`, `paved status` |
| `output_sha256` matches stored check output | Planned (CLI) | `paved verify` |
| Human gates approved by a human | Planned (CLI) | needs an approval record format |
| Stale context (source hash mismatch) | Planned (CLI) | `paved status` |
| Lock digests match resolved content | Enforced (CLI) | `paved generate`, `paved status`, `paved doctor` |
| Generators never overwrite human edits | Planned (generator runtime) | merge strategy |
| Destructive tools are not run without confirmation | Planned (tool runtime) | |
