# Architecture decisions

Significant decisions about the Paved Core, one file each. A decision is changed by
writing a new record that supersedes it, not by editing the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-core-vs-project-context.md) | Core vs Project Context | Accepted |
| [0002](0002-adapter-architecture.md) | Adapter architecture | Accepted |
| [0003](0003-composition-and-overrides.md) | Composition and overrides | Accepted; amended by 0012 |
| [0004](0004-generated-vs-human-owned.md) | Generated vs human-owned knowledge | Accepted |
| [0005](0005-verification-evidence-separation.md) | Separating claims from observations | Accepted |
| [0006](0006-versioning-boundaries.md) | Versioning boundaries | Accepted |
| [0007](0007-skill-format.md) | Skill format | Accepted |
| [0008](0008-schema-format.md) | Schema and document format | Accepted |
| [0009](0009-knowledge-states-and-provenance.md) | Knowledge states and provenance | Accepted |
| [0010](0010-machine-readable-dependency-model.md) | Machine-readable dependency model | Accepted |
| [0011](0011-tooling-stack.md) | Tooling stack | Accepted |
| [0012](0012-qualified-references.md) | Qualified references and namespaces | Accepted |
| [0013](0013-generated-artifact-metadata.md) | Generated artifact metadata | Accepted |
| [0014](0014-skill-contract.md) | Skill contract, versioning and composition | Accepted |
| [0015](0015-workflow-contract.md) | Workflow contract, run state and no workflow composition | Accepted |
| [0016](0016-verification-check-and-completion.md) | Check definitions, revision-bound evidence and deterministic completion | Accepted |
| [0017](0017-tool-capability-and-resolution.md) | Capability contracts and implementation resolution | Accepted |
| [0018](0018-tool-safety-and-evidence.md) | Tool safety boundaries and evidence capture | Accepted |
| [0019](0019-source-control-boundary.md) | Source-control capability ownership | Accepted |
| [0020](0020-generator-runtime-and-baselines.md) | Generator runtime and trusted regeneration baselines | Accepted |
| [0021](0021-adapter-capabilities-and-local-resolution.md) | Adapter capabilities and local resolution | Accepted |
| [0022](0022-consumer-lifecycle-and-atomic-local-update.md) | Consumer lifecycle and atomic local update | Accepted |
| [0023](0023-read-only-consumer-gardener.md) | Read-only consumer-scoped Gardener | Accepted |
| [0024](0024-agent-integration-projections.md) | Agent integration projections | Accepted |
| [0025](0025-packaged-runtime-and-workflow-execution.md) | Packaged runtime and executable workflow state | Accepted |
| [0026](0026-native-plugin-distribution.md) | Native plugin distribution and explicit runtime upgrade | Accepted |
| [0027](0027-scoped-capability-provider-resolution.md) | Scoped capability provider resolution | Accepted |
| [0028](0028-conversational-decision-resolution.md) | Conversational decision resolution | Accepted |
| [0029](0029-module-testing-suites.md) | Module testing suites | Accepted |

## Format

Each record has: Status (`Proposed`, `Accepted`, `Superseded by NNNN`), Date, Context,
Decision, Consequences, Alternatives considered, References. Number records
sequentially; never reuse a number.
