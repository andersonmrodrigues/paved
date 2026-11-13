# Working with AWS

Use this guidance when a change touches AWS infrastructure definitions, AWS SDK calls or
anything deployed to an AWS account. The repository decides which services, tools and
environments are in play; AWS support alone does not mean the project uses CDK, SAM or
any particular service.

## Where AWS knowledge comes from

AWS changes faster than any guidance shipped here. Prefer live, versioned sources over
memory:

- If the Agent Toolkit for AWS `aws-core` plugin is installed, load its skill for the
  task before acting. Use the closest match:

  | Task | aws-core skill |
  |---|---|
  | CDK stacks, constructs, `cdk synth/diff/deploy`, bootstrap, drift | `aws-cdk` |
  | CloudFormation templates, change sets, failed stacks | `aws-cloudformation` |
  | Lambda, API Gateway, Step Functions, SAM, EventBridge | `aws-serverless` |
  | ECS, Fargate, ECR | `aws-containers` |
  | EC2, Auto Scaling and other compute | `aws-compute` |
  | VPC, subnets, load balancers, DNS | `aws-networking` |
  | IAM policies, roles, least privilege | `aws-iam` |
  | Secrets, credentials, API keys | `aws-secrets-manager` |
  | Broader security posture | `aws-security` |
  | Choosing or operating a database | `aws-database` |
  | S3 and other storage | `aws-storage` |
  | SQS, SNS, Kinesis, MSK | `aws-messaging-and-streaming` |
  | CloudWatch, X-Ray, CloudTrail, OpenTelemetry | `aws-observability` |
  | CodePipeline, CodeBuild, CodeDeploy | `aws-deployment` |
  | Bedrock and AgentCore | `amazon-bedrock` |
  | SDK code in JavaScript, Python or Swift | `aws-sdk-js-v3-usage`, `aws-sdk-python-usage`, `aws-sdk-swift-usage` |
  | Cost questions | `aws-billing-and-cost-management` |
  | Architecture or workload review | `aws-well-architected-review` |
  | Local credentials | `signing-in-to-aws` |

- If the AWS MCP Server is available, use `search_documentation` and
  `read_documentation` to confirm API parameters, limits and error codes, and
  `retrieve_skill` for a skill the host did not load. Use its sandboxed execution for
  AWS calls rather than an unaudited shell.
- If neither is available, say so once, suggest installing the `aws-core` plugin, and
  cite official AWS documentation for any service-specific claim. Record an unconfirmed
  API detail as an unknown instead of presenting it as fact.

## Before changing anything

- Read the infrastructure definitions the change touches (`cdk.json` and the CDK app,
  SAM or CloudFormation templates, Serverless Framework or Terraform files) and follow
  their existing stack layout, naming, tagging and environment conventions.
- Identify the target account and region from the repository's configuration. Never
  assume a default profile or region; ask when it is not declared.
- Treat the infrastructure-as-code as the source of truth. Change resources there, not
  through the console or ad hoc CLI calls, so the change is reviewed and repeatable.
- Look for stateful resources (databases, buckets, queues, user pools). Changing their
  logical ID, name or certain properties can replace them and lose data; check the
  removal and update policies before renaming or moving them.

## Security

- Grant least privilege: scope IAM actions and resources to what the code uses. Do not
  add `*` actions or resources to make an error go away; find the missing permission.
- Never read secret values into the session, logs, tests or evidence. Reference secrets
  by name or ARN and let them resolve at runtime (CloudFormation dynamic references,
  ECS or Lambda secret injection, or an injecting wrapper).
- Do not print, commit or paste credentials, session tokens or account-sensitive output.
  Keep `.aws/` files and generated `cdk.out` or `.aws-sam` output out of commits unless
  the repository already tracks them deliberately.

## Operating on real accounts

- Read-only inspection (describe, list, get) is safe for discovery but still runs
  against a real account; prefer it to guessing.
- Deploys, deletes and other mutating calls need explicit human confirmation that names
  the account, region and resources. A plan approval does not authorize a deployment it
  does not mention.
- Use previews first: `cdk diff`, CloudFormation change sets or `sam validate` show what
  would happen without doing it.

## Tests and verification

- Follow the repository's Paved verification profile. Common AWS checks are
  `cdk synth`, `sam validate --lint`, `cfn-lint` and `cfn-guard`; run them only when the
  project declares them.
- Unit-test infrastructure code with the framework's assertions (for example CDK
  `Template` assertions) when the project already does, and test SDK calls behind the
  project's existing client abstraction or stubs.
- Match evidence to the claim: a successful synth or lint proves the template is valid,
  not that a deployment succeeds or that the service behaves correctly. Record a deploy
  or runtime check that was not run as a verification gap.
