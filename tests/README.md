# Tests

Paved tests its own contracts. Run everything with:

```bash
npm run check    # type check (tsc, strict) + all tests
npm test         # tests only (node:test, TypeScript run natively by Node >= 22.18)
```

| Suite | What it proves |
|---|---|
| `schemas/` | Every schema compiles in Ajv strict mode, is registered in the Core manifest, has valid and invalid fixtures, and accepts/rejects them for the stated reason; shared definitions never reference document schemas; `apiVersion` compatibility (missing, malformed, newer, older); YAML templates validate; the check-type enum matches the verification registry. |
| `skills/` | Every Core skill has Agent Skills-compliant frontmatter, all required sections, a valid `skill.yaml` whose id matches its location, and exactly the supporting files it lists. Every category has a skill. Skills pass the quality checks (size, genericity, contract mentioned in the body, no copied rules), the dependency graph is acyclic, no sentence repeats across skills, and no required check type proves nothing. Fixtures prove each quality check fails when it should, and that evidence is assessed against its producer skills. |
| `workflows/` | Every workflow is valid, identified by its directory, and passes `assessWorkflowQuality`; the canonical order equals `lifecycle.md`; quality, run and workflow-evidence fixtures produce exactly the stated problems. |
| `generators/` | Every generator contract is valid, documents the required aspects, has an acyclic dependency graph, **writes only to generated-reviewed or disposable paths** of the consumer layout, and declares inline metadata only where the output schema has provenance. |
| `core/` | Manifest validity and version consistency, consumer ownership model, component boundaries, rule and tool validity with ids matching paths, reference resolution and visibility across Core content, templates and fixtures, evidence semantics (a build cannot prove behavior; self-reported reviews prove nothing; the recorder policy), and that every relative Markdown link resolves. |
| `provenance/` | Cited sources are declared and managed blocks are well formed, in templates and fixtures. |
| `verification/` | Synthetic Check, profile and Evidence fixtures validate; completion status and verification level are assessed for success, failure, blocked, skipped, inconclusive, partial, flaky, performance and runtime results. A result whose exit code contradicts its Check is rejected. |
| `tools/` | Tool and binding contracts validate; discovery does not authorize execution; safety, permissions, preconditions, input/output contracts, resolution, explicit overrides, bounded retries, redaction and revision-bound Evidence conversion are checked with synthetic implementations. |
| `fixtures/` | Inputs for the suites above (see its README). |

When a test here fails after a content change, the content usually broke a contract. Fix
the content, or change the contract deliberately (schema + changelog + version, see
`docs/concepts/versioning.md`).
