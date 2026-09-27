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

When more than one selected adapter provides one capability, resolution reports an
**ambiguous provider**. The consumer may set `capability_providers` in its manifest to
select one explicitly. A missing provider is **unavailable**. A consumer may still
receive generic context when a selected adapter is unavailable, but the missing evidence
is never invented.

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

The initial adapter set separates Java source and build knowledge, Quarkus runtime and
HTTP declarations, Angular workspace, lockfile-resolved core versions and UI routes, PostgreSQL database declarations,
and Git source control. Quarkus depends on Java; Angular and PostgreSQL are independent
of the application language and framework. Maven is covered inside the Java adapter's
build evidence because no separate Paved capability currently requires a Maven adapter.
The selected adapters describe evidence; project architecture and business meaning stay
in the consumer's `.paved/project/` documents.
