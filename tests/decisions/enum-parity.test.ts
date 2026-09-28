import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type {
  AnswerChannel,
  AnswerSource,
  DecisionAuthor,
  DecisionCategory,
  DecisionRisk,
  DecisionReversibility,
  DecisionStatus,
  EffectClass,
  RequiredAnswerType,
} from "../../cli/lib/decisions/record.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const schemaPath = join(root, "schemas", "decision.schema.yaml");
const schema = parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;

// Exhaustive type-checked maps: adding a member to the union without adding it here is a compile error.
const DECISION_STATUS: Record<DecisionStatus, true> = {
  PENDING: true,
  ASKED: true,
  ANSWERED: true,
  APPLIED: true,
  REJECTED: true,
  CANCELLED: true,
  SUPERSEDED: true,
};

const DECISION_CATEGORY: Record<DecisionCategory, true> = {
  deterministic: true,
  material: true,
};

const DECISION_AUTHOR: Record<DecisionAuthor, true> = {
  runtime: true,
  agent: true,
};

const ANSWER_SOURCE: Record<AnswerSource, true> = {
  derived: true,
  "agent-relayed": true,
  "human-authored": true,
};

const ANSWER_CHANNEL: Record<AnswerChannel, true> = {
  relayed: true,
  "human-authored": true,
};

const DECISION_RISK: Record<DecisionRisk, true> = {
  low: true,
  medium: true,
  high: true,
};

const DECISION_REVERSIBILITY: Record<DecisionReversibility, true> = {
  reversible: true,
  recoverable: true,
  irreversible: true,
};

const REQUIRED_ANSWER_TYPE: Record<RequiredAnswerType, true> = {
  "single-choice": true,
  "multi-choice": true,
  boolean: true,
  "free-text": true,
};

const EFFECT_CLASS: Record<EffectClass, true> = {
  "record-only": true,
  "config-additive": true,
  "config-mutating": true,
  "lock-transaction": true,
  "repository-mutating": true,
  destructive: true,
};

describe("enum parity between TypeScript and schema", () => {
  it("DecisionStatus union matches properties.status.enum", () => {
    const tsMembers = Object.keys(DECISION_STATUS).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.status as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `DecisionStatus diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("DecisionCategory union matches properties.category.enum", () => {
    const tsMembers = Object.keys(DECISION_CATEGORY).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.category as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `DecisionCategory diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("DecisionAuthor union matches properties.authored_by.enum", () => {
    const tsMembers = Object.keys(DECISION_AUTHOR).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.authored_by as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `DecisionAuthor diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("AnswerSource union matches properties.answer_source.enum", () => {
    const tsMembers = Object.keys(ANSWER_SOURCE).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.answer_source as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `AnswerSource diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("AnswerChannel union matches properties.answer_channel.enum", () => {
    const tsMembers = Object.keys(ANSWER_CHANNEL).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.answer_channel as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `AnswerChannel diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("DecisionRisk union matches properties.risk.enum", () => {
    const tsMembers = Object.keys(DECISION_RISK).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.risk as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `DecisionRisk diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("DecisionReversibility union matches properties.reversibility.enum", () => {
    const tsMembers = Object.keys(DECISION_REVERSIBILITY).sort();
    const schemaEnum = ((schema.properties as Record<string, unknown>)?.reversibility as Record<string, unknown>)?.enum as string[];
    const schemaMembers = [...(schemaEnum ?? [])].sort();
    assert.deepEqual(tsMembers, schemaMembers, `DecisionReversibility diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("RequiredAnswerType union matches properties.required_answer.properties.type.enum", () => {
    const tsMembers = Object.keys(REQUIRED_ANSWER_TYPE).sort();
    const requiredAnswer = (schema.properties as Record<string, unknown>)?.required_answer as Record<string, unknown>;
    const typeProps = (requiredAnswer?.properties as Record<string, unknown>)?.type as Record<string, unknown>;
    const schemaEnum = (typeProps?.enum as string[]) || [];
    const schemaMembers = [...schemaEnum].sort();
    assert.deepEqual(tsMembers, schemaMembers, `RequiredAnswerType diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });

  it("EffectClass union matches $defs.effectClass.enum", () => {
    const tsMembers = Object.keys(EFFECT_CLASS).sort();
    const effectClass = ((schema as Record<string, unknown>).$defs as Record<string, unknown>)?.effectClass as Record<string, unknown>;
    const schemaEnum = (effectClass?.enum as string[]) || [];
    const schemaMembers = [...schemaEnum].sort();
    assert.deepEqual(tsMembers, schemaMembers, `EffectClass diverges from schema: TS has ${tsMembers}, schema has ${schemaMembers}`);
  });
});
