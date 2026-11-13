# Infrastructure adapters

Knowledge tied to runtime and delivery platforms: container tooling, orchestrators,
cloud providers, infrastructure-as-code tools and CI systems. Typical content: how to
read deployment definitions, which operations are destructive, and how to observe a
running system.

Tools that act on shared environments are almost always `destructive` and require
confirmation.

## Included

- `infrastructure/git` binds the Core repository Tools to Git.
- `infrastructure/aws` detects AWS infrastructure-as-code and SDK usage, observes
  declared resource types and constructs, and routes AWS work to the Agent Toolkit for
  AWS (`aws-core` skills and AWS MCP Server) when the host has it. Terraform files are
  not read by source discovery, so Terraform-only repositories are not detected yet.
