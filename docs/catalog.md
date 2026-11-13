# Paved component catalog

This catalog is a reviewed index of the reusable components shipped in this
repository. It helps you choose what to read or select; it is not a package registry
and does not install third-party code. Adapter contracts link to their source metadata,
including official documentation and `reviewed_at`.

## Workflows

Choose the workflow by the kind of change, not by its size. Feature plans scale to the
work: a bounded, low-risk change with clear acceptance behavior can use a concise
approach, claims and checks; broad, ambiguous or high-impact work warrants deeper
planning. Every feature still requires plan approval, verification, evidence and review.

| Workflow | Use when | Contract and guidance |
|---|---|---|
| `feature` | Adding behavior or intentionally changing behavior | [workflow.yaml](../core/workflows/feature/workflow.yaml) · [WORKFLOW.md](../core/workflows/feature/WORKFLOW.md) |
| `bug` | Actual behavior differs from intended behavior | [workflow.yaml](../core/workflows/bug/workflow.yaml) · [WORKFLOW.md](../core/workflows/bug/WORKFLOW.md) |
| `refactor` | Changing structure without changing behavior | [workflow.yaml](../core/workflows/refactor/workflow.yaml) · [WORKFLOW.md](../core/workflows/refactor/WORKFLOW.md) |
| `performance` | Improving a measured metric without changing behavior; needs a baseline before any change | [workflow.yaml](../core/workflows/performance/workflow.yaml) · [WORKFLOW.md](../core/workflows/performance/WORKFLOW.md) |
| `investigation` | Answering how or why something works, with cited sources and no change | [workflow.yaml](../core/workflows/investigation/workflow.yaml) · [WORKFLOW.md](../core/workflows/investigation/WORKFLOW.md) |

## Workflow fragments

Fragments reuse Core phase guidance, skills and required Tools without adding lifecycle
phases or nested runs. Bind the declared inputs from `phases[].fragments[].with`; see
[authoring and exact interpolation](concepts/workflows.md#reusable-workflow-fragments)
and the [fragment README](../core/workflow-fragments/README.md).

| Fragment | Use when | Contract and guidance |
|---|---|---|
| `core.fragment.context-discovery` | Locating affected code, a nearby pattern and verification for a named `subject` | [fragment.yaml](../core/workflow-fragments/context-discovery/fragment.yaml) · [FRAGMENT.md](../core/workflow-fragments/context-discovery/FRAGMENT.md) |

Workflows may also declare an optional autonomy default (`guided`, `balanced` or
`autonomous`) and phase-selected local Tool policies (`allow`, `ask`, `deny`). Existing
workflows without these fields retain their behavior. Explicit run selection overrides
the default, and profiles and policies preserve mandatory gates, approvals,
verification, evidence and host permissions; see [workflow controls](concepts/workflows.md).

## Adapters

Select adapters supported by repository evidence. Dependencies are resolved from the
adapter contracts: Quarkus requires Java, and Flutter requires Dart.

| Adapter | Adds reusable guidance for | Contract |
|---|---|---|
| `infrastructure/aws` | AWS infrastructure-as-code (CDK, CloudFormation, SAM) and SDK usage, routed to the Agent Toolkit for AWS when installed | [adapter.yaml](../adapters/infrastructure/aws/adapter.yaml) |
| `infrastructure/git` | Git repositories, source control and worktrees | [adapter.yaml](../adapters/infrastructure/git/adapter.yaml) |
| `technology/angular` | Angular applications | [adapter.yaml](../adapters/technology/angular/adapter.yaml) |
| `technology/dart` | Dart projects | [adapter.yaml](../adapters/technology/dart/adapter.yaml) |
| `technology/flutter` | Flutter applications, including shared iOS, Android and Web targets | [adapter.yaml](../adapters/technology/flutter/adapter.yaml) |
| `technology/java` | Java projects and their build and test conventions | [adapter.yaml](../adapters/technology/java/adapter.yaml) |
| `technology/postgresql` | PostgreSQL schemas, queries and database practices | [adapter.yaml](../adapters/technology/postgresql/adapter.yaml) |
| `technology/quarkus` | Quarkus applications | [adapter.yaml](../adapters/technology/quarkus/adapter.yaml) |
| `technology/typescript` | TypeScript projects | [adapter.yaml](../adapters/technology/typescript/adapter.yaml) |

## Examples

These examples are synthetic unless their document says otherwise. Treat them as
shapes to adapt, not project facts or required templates.

| Example | Useful for |
|---|---|
| [Feature task](../core/skills/product/task-specification/examples/feature-task.md) | Turning a feature request into acceptance criteria grounded in repository context |
| [Bug task](../core/skills/product/task-specification/examples/bug-task.md) | Describing a bug and its expected behavior |
| [Split epic](../core/skills/product/task-specification/examples/split-epic.md) | Breaking cross-cutting work into independently deliverable tasks |
| [Investigation log](../core/skills/debugging/bug-investigation/examples/investigation-log.md) | Recording evidence while tracing a defect |
| [Threat model](../core/skills/security/threat-modeling/examples/threat-model.md) | Structuring security analysis before implementation |

## Extending the catalog

For project-specific needs, add skills, workflows, tools and rules under `.paved/`;
for technology-specific knowledge, propose an adapter. Follow the [extensibility
guide](concepts/extensibility.md) and the [Core maintenance guide](maintenance/evolving-the-core.md).
New or renamed built-in adapters, workflows, workflow fragments or examples should update this index and
their owning README or contract in the same change.
