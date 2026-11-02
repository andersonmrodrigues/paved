# Example fragment

<!-- Instantiated as FRAGMENT.md next to fragment.yaml under
     core/workflow-fragments/<name>/. Declare every input, skill and tool in the metadata.
     Interpolate only declared inputs; do not copy skill procedures
     or redefine workflow gates, approval requirements or tool safety classes. -->

Use `core.discovery.context-discovery` to locate the context needed for {{ inputs.goal }}.
Inspect the working tree with `core.repository.status` and carry the findings into the
workflow phase that binds this fragment.
