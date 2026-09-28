import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { loadYaml } from "./documents.ts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SchemaRegistry {
  /** Check the document's `apiVersion`, then validate it against the schema registered for its `kind`. */
  validate(document: unknown): ValidationResult;
  validateAs(schemaId: string, document: unknown): ValidationResult;
  schemaIds(): string[];
}

type SchemaObject = { $id: string } & Record<string, unknown>;

export function loadSchemas(schemasDir: string): SchemaObject[] {
  return readdirSync(schemasDir)
    .filter((file) => file.endsWith(".schema.yaml"))
    .sort()
    .map((file) => {
      const schema = loadYaml(join(schemasDir, file));
      if (schema === null || typeof schema !== "object" || typeof (schema as { $id?: unknown }).$id !== "string") {
        throw new Error(`${file}: schema must be a mapping with a string $id`);
      }
      return schema as SchemaObject;
    });
}

// Maps a document `kind` to the schema that validates it. Kept explicit so that adding
// a kind is a deliberate change reviewed alongside its schema.
const KIND_TO_SCHEMA: Readonly<Record<string, string>> = {
  Core: "urn:paved:schema:manifest:v1",
  Project: "urn:paved:schema:manifest:v1",
  Lock: "urn:paved:schema:lock:v1",
  Adapter: "urn:paved:schema:adapter:v1",
  CapabilityRegistry: "urn:paved:schema:capability-registry:v1",
  Rule: "urn:paved:schema:rule:v1",
  Skill: "urn:paved:schema:skill:v1",
  Workflow: "urn:paved:schema:workflow:v1",
  WorkflowRun: "urn:paved:schema:workflow-run:v1",
  Check: "urn:paved:schema:check:v1",
  Tool: "urn:paved:schema:tool:v1",
  ToolImplementation: "urn:paved:schema:tool-implementation:v1",
  Evidence: "urn:paved:schema:evidence:v1",
  VerificationProfile: "urn:paved:schema:verification:v1",
  Feature: "urn:paved:schema:feature:v1",
  ContextDocument: "urn:paved:schema:project-context:v1",
  Overrides: "urn:paved:schema:override:v1",
  Generator: "urn:paved:schema:generator:v1",
  GeneratedArtifact: "urn:paved:schema:generated-artifact:v1",
  GardenerObservation: "urn:paved:schema:gardener-observation:v1",
  GardenerProposal: "urn:paved:schema:gardener-proposal:v1",
  GardenerReviews: "urn:paved:schema:gardener-review:v1",
  CoreImprovementCandidate: "urn:paved:schema:core-improvement-candidate:v1",
  AgentIntegration: "urn:paved:schema:agent-integration:v1",
};

export function schemaIdForKind(kind: string): string | undefined {
  return KIND_TO_SCHEMA[kind];
}

const API_VERSION = /^paved\/v(\d+)$/;

/**
 * Compatibility of a document's `apiVersion` with the versions this Core reads. Checked
 * before schema validation so that a version problem is reported as such, not as a
 * list of unrelated field errors.
 */
export function checkApiVersion(apiVersion: unknown, supported: readonly string[]): string | undefined {
  if (apiVersion === undefined) {
    return "document has no `apiVersion`; every Paved document declares one";
  }
  const match = typeof apiVersion === "string" ? API_VERSION.exec(apiVersion) : null;
  if (!match) {
    return `apiVersion ${JSON.stringify(apiVersion)} is not a Paved API version (expected paved/v<N>)`;
  }
  if (supported.includes(apiVersion as string)) {
    return undefined;
  }
  const version = Number(match[1]);
  const known = supported.map((v) => Number(API_VERSION.exec(v)?.[1])).filter((n) => !Number.isNaN(n));
  if (known.length > 0 && version > Math.max(...known)) {
    return `apiVersion ${apiVersion} is newer than this Core supports (${supported.join(", ")}); update Paved`;
  }
  if (known.length > 0 && version < Math.min(...known)) {
    return `apiVersion ${apiVersion} is older than this Core supports (${supported.join(", ")}); migrate the document`;
  }
  return `apiVersion ${apiVersion} is not supported by this Core (${supported.join(", ")})`;
}

export function createRegistry(schemasDir: string, supportedApiVersions: readonly string[]): SchemaRegistry {
  // strictRequired is off because conditional `required` in if/then branches is idiomatic
  // JSON Schema; every other strict check stays on.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  const schemas = loadSchemas(schemasDir);
  for (const schema of schemas) {
    ajv.addSchema(schema);
  }
  const compiled = new Map<string, ValidateFunction>();
  const validatorFor = (id: string): ValidateFunction => {
    let fn = compiled.get(id);
    if (!fn) {
      fn = ajv.getSchema(id);
      if (!fn) {
        throw new Error(`Unknown schema ${id}`);
      }
      compiled.set(id, fn);
    }
    return fn;
  };

  const run = (id: string, document: unknown): ValidationResult => {
    const fn = validatorFor(id);
    const valid = fn(document) === true;
    return { valid, errors: valid ? [] : formatErrors(fn.errors ?? []) };
  };

  return {
    validateAs: run,
    validate(document) {
      const fields: { apiVersion?: unknown; kind?: unknown } =
        document !== null && typeof document === "object" ? document : {};
      const versionProblem = checkApiVersion(fields.apiVersion, supportedApiVersions);
      if (versionProblem) {
        return { valid: false, errors: [versionProblem] };
      }
      const kind = fields.kind;
      if (typeof kind !== "string") {
        return { valid: false, errors: ["document has no string `kind`"] };
      }
      const id = schemaIdForKind(kind);
      if (!id) {
        return { valid: false, errors: [`unknown kind "${kind}"`] };
      }
      return run(id, document);
    },
    schemaIds: () => schemas.map((schema) => schema.$id),
  };
}

function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}
