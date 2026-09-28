# Adapters and capabilities

A **capability** is a technology-neutral thing Paved needs to observe or do. The Core
registry at `core/capabilities/registry.yaml` defines each capability's meaning and a
concrete consumer. A Tool contract may expose an executable capability; the Git adapter
already binds the Core repository status, diff and history Tools. The registry maps
those meanings to the existing Tool capability strings. Repository-static
capabilities expose observed evidence to generators. A provider is an adapter that
implements a capability for one technology.

An **adapter** is a versioned `adapter.yaml` in `adapters/<category>/<name>/`. Its
contract declares a stable ID, independent SemVer version, Core range, optional adapter
dependencies, deterministic detection signals, evidence providers, optional Tool
implementations, metadata, and official sources. The existing adapter schema validates
this one contract. Adapters carry reusable technology knowledge and no consumer policy.

**Detection** checks repository evidence and produces candidate adapters with confidence
`strong`, `medium`, `weak`, or `unknown`. Content matches are strong by default; file-only
matches remain weak or medium, except the `.git` marker. Detection does not resolve a
provider. **Resolution** takes a consumer's selected adapter IDs and ranges, checks Core
compatibility and adapter dependencies, and returns a deterministic set plus structured
diagnostics. Missing, incompatible, cyclic and undetected selections do not silently
resolve. The local lock records exact versions and content digests. No remote registry
is involved.

When more than one selected adapter provides one capability, resolution works per
**scope**: the outermost directories holding the files that detected each adapter. Each
scope goes to the provider with the nearest enclosing scope; when two providers share a
scope and one declares the other in `requires.adapters` (Angular requires TypeScript,
Flutter requires Dart), the more specific one wins. Evidence for the capability is then
collected per scope, so a Java build never reads frontend sources and vice versa.
Precedence is: a manifest override (`capability_providers.<id>: <adapter>`), then
manifest scoped selections, then this inference. A scope that unrelated providers claim
equally stays an **ambiguous provider** and is never guessed; a missing provider is
**unavailable**. A consumer may still receive generic context when a selected adapter is
unavailable, but the missing evidence is never invented.

For a repository with `services/api/pom.xml` (Quarkus) and `web/angular.json` plus
`web/tsconfig.json`, `paved init` needs no configuration and records in `paved.lock`:

```yaml
capabilities:
  - id: source.build
    status: scoped
    candidates: [technology/java, technology/typescript]
    providers:
      - { scope: services/api, provider: technology/java, source: inferred, evidence: [services/api/pom.xml] }
      - { scope: web, provider: technology/typescript, source: inferred, evidence: [web/package.json, web/tsconfig.json] }
```

Only capabilities that needed a decision are recorded, so single-stack locks carry no
`capabilities` section. Inferred decisions live in the tool-managed lock, never in the
human-owned manifest; `status` and `paved agent commands --json` report every
capability's providers as `capabilityProviders`, and `status` flags a lock whose
decisions no longer match the repository until `paved update` records them. Where a
scope is genuinely ambiguous, select a provider for that path only:

```yaml
capability_providers:
  source.build:
    - { path: ., provider: technology/java }
```

Adapter evidence records adapter ID and version, capability, source path and SHA-256,
detection signals and confidence, and `observed` classification. The existing generator
provenance stores source hashes and adapter metadata. Bounded identifier captures omit
secret-like names; configuration values are not emitted. Static evidence does not query
databases or start applications. Observed patterns do not create Rules, Skills, Tools or
Verification requirements. A verification generator may show test configuration as a
draft observation, requiring project review before adoption.

**Paved does not attempt to model every technology present in a repository.** A detected
technology requires an adapter only when technology-specific knowledge is necessary for
a Paved capability. Node package scripts and CI configuration may remain unmodeled.
Their detection is useful context but does not require Node or CI adapters. An unmatched
or unmodeled item is not an error by itself.

The current adapter set covers Git source control, Java source/builds, Quarkus runtime
and HTTP declarations, TypeScript, Angular workspaces and routes, Dart, Flutter, and
PostgreSQL declarations. Quarkus depends on Java and Flutter depends on Dart; Angular
and PostgreSQL remain independent of the application language and framework. Maven is
covered inside the Java adapter because no separate Paved capability currently requires
a Maven adapter. The selected adapters describe evidence; project architecture and
business meaning stay in the consumer's `.paved/project/` documents.
