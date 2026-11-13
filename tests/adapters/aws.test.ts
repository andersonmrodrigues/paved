import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { capabilityEvidence, detectAdapters, loadAdapters, resolveAdapters } from "../../cli/lib/adapters.ts";
import { compatible } from "../../cli/lib/tools.ts";
import { discoverSources, relevantEvidenceFor } from "../../cli/lib/generator-runtime.ts";
import { at, cleanupTemporaryDirectories, coreManifest, formatErrors, schemas, temporaryDirectory } from "../helpers.ts";

const root = at("adapters", "infrastructure", "aws");
const adapters = loadAdapters(at());
afterEach(cleanupTemporaryDirectories);

function repository(files: Record<string, string>): string {
  const project = temporaryDirectory("paved-aws");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  return project;
}

function detect(project: string) {
  const sources = discoverSources(project);
  const detection = detectAdapters(project, adapters, sources).find((item) => item.adapter.id === "infrastructure/aws")!;
  return { sources, detection };
}

function evidence(project: string) {
  const { sources, detection } = detect(project);
  assert.equal(detection.confidence, "strong");
  const resolved = resolveAdapters([detection], [{ id: detection.adapter.id, version: `^${detection.adapter.version}` }], coreManifest().version);
  assert.deepEqual(resolved.diagnostics, []);
  return capabilityEvidence(project, sources, resolved.adapters).evidence
    .filter((item) => item.capability === "infrastructure.definitions");
}

const samTemplate = [
  "AWSTemplateFormatVersion: '2010-09-09'",
  "Transform: AWS::Serverless-2016-10-31",
  "Resources:",
  "  Handler:",
  "    Type: AWS::Serverless::Function",
  "  Table:",
  "    Type: 'AWS::DynamoDB::Table'",
  "  Credentials:",
  "    Type: AWS::SecretsManager::Secret",
  "",
].join("\n");

describe("AWS adapter contract", () => {
  it("is schema-valid, Core-compatible and ships every referenced file", () => {
    const adapter = loadYaml(join(root, "adapter.yaml")) as {
      requires: { core: string };
      provides: { knowledge: string[]; rules: string[]; capabilities: { id: string }[] };
    };
    const result = schemas().validate(adapter);
    assert.ok(result.valid, formatErrors("adapter.yaml", result.errors));
    assert.ok(compatible(coreManifest().version, adapter.requires.core));
    for (const path of [...adapter.provides.knowledge, ...adapter.provides.rules]) {
      assert.ok(existsSync(join(root, path)), `${path} is missing`);
    }
    assert.deepEqual(adapter.provides.capabilities.map((item) => item.id), ["infrastructure.definitions"]);
  });

  it("namespaces its rules under adapter-aws and keeps them schema-valid", () => {
    const adapter = loadYaml(join(root, "adapter.yaml")) as { provides: { rules: string[] } };
    for (const path of adapter.provides.rules) {
      const rule = loadYaml(join(root, path)) as { id: string };
      const result = schemas().validate(rule);
      assert.ok(result.valid, formatErrors(path, result.errors));
      const [, category, file] = path.match(/^rules\/([a-z-]+)\/([a-z-]+)\.yaml$/)!;
      assert.equal(rule.id, `adapter-aws.${category}.${file}`);
    }
  });

  it("keeps secret retrieval non-overridable", () => {
    const rule = loadYaml(join(root, "rules/security/no-direct-secret-retrieval.yaml")) as { overridable: boolean; severity: string };
    assert.equal(rule.overridable, false);
    assert.equal(rule.severity, "error");
  });
});

describe("AWS adapter detection", () => {
  const positives: Record<string, Record<string, string>> = {
    "CDK TypeScript app": {
      "cdk.json": '{ "app": "npx ts-node bin/app.ts" }',
      "package.json": '{ "dependencies": { "aws-cdk-lib": "2.170.0" } }',
    },
    "CDK Python app": {
      "cdk.json": '{ "app": "python3 app.py" }',
      "requirements.txt": "aws-cdk-lib==2.170.0\nconstructs>=10.0.0\n",
    },
    "SAM template": { "template.yaml": samTemplate, "samconfig.toml": 'version = 0.1\n[default.deploy.parameters]\nstack_name = "app"\n' },
    "CloudFormation JSON template": { "infra/stack.json": '{ "AWSTemplateFormatVersion": "2010-09-09", "Resources": {} }' },
    "Serverless Framework": { "serverless.yml": "service: app\nprovider:\n  name: aws\n  runtime: nodejs20.x\n" },
    "JavaScript SDK v3": { "package.json": '{ "dependencies": { "@aws-sdk/client-s3": "3.700.0" } }' },
    "boto3 in pyproject": { "pyproject.toml": '[project]\ndependencies = ["boto3>=1.35"]\n' },
    "Java SDK v2": { "pom.xml": "<project><dependency><groupId>software.amazon.awssdk</groupId><artifactId>s3</artifactId></dependency></project>" },
  };

  for (const [name, files] of Object.entries(positives)) {
    it(`selects the adapter for a ${name}`, () => {
      assert.equal(detect(repository(files)).detection.confidence, "strong");
    });
  }

  it("does not select the adapter for files that only mention AWS", () => {
    const project = repository({
      "config.yaml": "cloud: aws\nregion: us-east-1\n",
      "README.md": "Deployed on AWS with CloudFormation.\n",
      "package.json": '{ "dependencies": { "aws4": "1.13.2" } }',
      "requirements.txt": "boto3-stubs-lite\n",
    });
    assert.equal(detect(project).detection.confidence, "unknown");
  });

  it("treats a bare cdk.json without an app entry as weak at most", () => {
    const project = repository({ "cdk.json": "{}" });
    assert.notEqual(detect(project).detection.confidence, "strong");
  });

  it("does not read synthesized cdk.out or .aws-sam output", () => {
    const project = repository({
      "cdk.out/AppStack.template.json": '{ "AWSTemplateFormatVersion": "2010-09-09" }',
      ".aws-sam/build/template.yaml": samTemplate,
    });
    assert.equal(detect(project).detection.confidence, "unknown");
  });
});

describe("AWS infrastructure definitions evidence", () => {
  it("captures CloudFormation and SAM resource types without secret-like values", () => {
    const values = evidence(repository({ "template.yaml": samTemplate })).map((item) => item.value);
    assert.deepEqual(values.sort(), ["AWS::DynamoDB::Table", "AWS::Serverless::Function"]);
  });

  it("captures CDK constructs in TypeScript and Python", () => {
    const project = repository({
      "cdk.json": '{ "app": "npx ts-node bin/app.ts" }',
      "lib/stack.ts": "new lambda.Function(this, 'Handler', {});\nnew s3.Bucket(this, 'Assets');\nconst x = new Map();\n",
      "stacks/data.py": "table = dynamodb.Table(self, \"Items\", partition_key=key)\n",
    });
    const found = evidence(project).map((item) => `${item.statement}:${item.value}`).sort();
    assert.deepEqual(found, [
      "AWS CDK construct instantiation:dynamodb.Table",
      "AWS CDK construct instantiation:lambda.Function",
      "AWS CDK construct instantiation:s3.Bucket",
    ]);
  });

  it("feeds the architecture and integrations context generators", () => {
    const items = evidence(repository({ "template.yaml": samTemplate }));
    assert.ok(items.length > 0);
    for (const generator of ["project-context/architecture", "project-context/integrations"]) {
      assert.equal(relevantEvidenceFor(generator, items).length, items.length, generator);
    }
    assert.equal(relevantEvidenceFor("project-context/domain", items).length, 0);
  });
});
