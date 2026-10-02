# Integrations generator

## Input

HTTP and SDK clients, API specifications, messaging configuration, environment variable
declarations, infrastructure definitions; adapter knowledge about client declaration.

## Output

Markdown documents under `.paved/project/integrations/`, one section per external
system: what it is, direction (inbound, outbound), protocol, where the client or
endpoint is defined, how it is configured (variable names only, never values), and how
it is exercised in tests (mocked, containerized, real).

## Preconditions

Architecture context exists, so integrations can be attributed to components.

## Sources analyzed

Client code and SDK usage, API specification files, message broker configuration,
environment and configuration declarations, infrastructure-as-code, test doubles.

## Strategy

1. Detect clients, endpoints and broker bindings with adapter-provided patterns.
2. Group them by external system and attribute them to components.
3. Read configuration keys to show how each integration is configured, never the values.
4. Link test doubles to the integration they replace.

## Limitations

Integrations configured entirely at runtime or outside the repository are not visible.
The purpose of an integration is often not in code.

## Unknown information

Unclear purpose, owner, criticality or failure behavior of an integration is recorded as
`unknowns`.

## Avoiding invention

An integration is listed only with the code or configuration that proves it exists.
Secret values are never read into output (`core.security.no-secrets-in-source`).

## Change detection

Source hashes of client code, specifications and configuration declarations.
