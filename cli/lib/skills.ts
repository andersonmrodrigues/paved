// Checks on skills that JSON Schema cannot express: the dependency graph, whether a skill
// stays small, generic and verifiable, and whether an evidence record satisfies the
// skills that produced it. Run after schema validation. See docs/concepts/skills.md.

export interface SkillContract {
  id: string;
  category: string;
  status: string;
  tools?: { required?: string[]; optional?: string[] };
  rules?: string[];
  depends_on?: { required?: string[]; optional?: string[] };
  verification: { required: string[]; recommended?: string[] };
  evidence: { required: string[] };
  references?: string[];
}

export interface SkillFiles {
  contract: SkillContract;
  /** SKILL.md frontmatter `description`. */
  description: string;
  /** SKILL.md body. */
  body: string;
  /** Supporting Markdown files, by path relative to the skill directory. */
  supporting: Record<string, string>;
}

export const SKILL_MAX_LINES = 150;
export const SKILL_MAX_WORDS = 1500;
export const REFERENCE_MAX_LINES = 300;

/** Categories whose skills change code, so their outcome must be proven. */
export const CHANGE_CATEGORIES = new Set(["development", "debugging", "testing", "performance"]);

// Named technologies and products. A generic skill says "the project's test command";
// adapters and project context supply the specifics. Git is the one assumption the Core
// makes (its tools are Git tools).
const TECHNOLOGY =
  /\b(maven|mvn|gradle|npm|yarn|pnpm|pip|poetry|pytest|jest|junit|mocha|vitest|cypress|playwright|selenium|docker|kubernetes|kubectl|helm|terraform|angular|vue|svelte|django|flask|laravel|spring boot|java|python|javascript|typescript|golang|ruby|php|kotlin|swift|dotnet|postgres(ql)?|mysql|mongodb|redis|kafka|rabbitmq|aws|azure|gcp|jenkins|github actions|gitlab ci)\b/i;

// Compound identifiers such as a class or service name are project facts, not procedure.
const IDENTIFIER = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/;

// Commands belong to tools and the verification profile, not to skills.
const SHELL_BLOCK = /^```(bash|sh|shell|zsh|console|powershell|cmd)\s*$/m;

const ACTIVATION = /\bUse (when|for|before|after|to)\b/;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Technology names, project identifiers and shell blocks in Core prose. */
export function genericityProblems(path: string, text: string): string[] {
  const problems: string[] = [];
  const technology = TECHNOLOGY.exec(text);
  if (technology) problems.push(`${path} names a specific technology ("${technology[0]}"); that belongs in an adapter`);
  const identifier = IDENTIFIER.exec(text);
  if (identifier) problems.push(`${path} contains the identifier "${identifier[0]}"; project facts belong in Project Context`);
  if (SHELL_BLOCK.test(text)) problems.push(`${path} contains a shell command block; commands belong in tools`);
  return problems;
}

/** Whether a description says when to activate what it describes. */
export const saysWhenToUse = (description: string): boolean => ACTIVATION.test(description);

/** Problems with one skill's size, genericity, verifiability and internal consistency. */
export function assessSkillQuality(skill: SkillFiles, ruleStatements: ReadonlyMap<string, string> = new Map()): string[] {
  const { contract, body } = skill;
  const problems: string[] = [];
  const lines = body.split("\n").length;
  const words = body.split(/\s+/).filter(Boolean).length;
  if (lines > SKILL_MAX_LINES || words > SKILL_MAX_WORDS) {
    problems.push(
      `SKILL.md has ${lines} lines and ${words} words (limits ${SKILL_MAX_LINES} and ${SKILL_MAX_WORDS}); move detail to references/`,
    );
  }
  for (const [path, text] of Object.entries(skill.supporting)) {
    if (text.split("\n").length > REFERENCE_MAX_LINES) {
      problems.push(`${path} is longer than ${REFERENCE_MAX_LINES} lines; split it`);
    }
  }

  const texts: [string, string][] = [["SKILL.md", `${skill.description}\n${body}`], ...Object.entries(skill.supporting)];
  for (const [path, text] of texts) problems.push(...genericityProblems(path, text));
  if (!saysWhenToUse(skill.description)) {
    problems.push('description does not say when to use the skill ("Use when …")');
  }

  const allText = normalize(texts.map(([, text]) => text).join("\n"));
  for (const rule of contract.rules ?? []) {
    const statement = ruleStatements.get(rule);
    if (statement !== undefined && allText.includes(normalize(statement))) {
      problems.push(`copies the text of rule ${rule}; reference the rule instead`);
    }
  }

  // Everything the contract names is explained in SKILL.md, so the procedure and the
  // contract cannot drift apart silently.
  const named = [
    ...(contract.tools?.required ?? []),
    ...(contract.tools?.optional ?? []),
    ...(contract.rules ?? []),
    ...(contract.references ?? []),
  ];
  for (const id of named) {
    if (!body.includes(id)) problems.push(`SKILL.md never mentions ${id}, which skill.yaml lists`);
  }
  for (const id of [...(contract.depends_on?.required ?? []), ...(contract.depends_on?.optional ?? [])]) {
    const name = id.split(".").at(-1)!;
    if (!body.includes(name)) problems.push(`SKILL.md never says when to use ${id}, which skill.yaml lists as a dependency`);
  }

  if (CHANGE_CATEGORIES.has(contract.category)) {
    if (contract.verification.required.length === 0) {
      problems.push(`a ${contract.category} skill changes code and must require verification`);
    }
    if (contract.evidence.required.length === 0) {
      problems.push(`a ${contract.category} skill changes code and must require evidence`);
    }
  }
  return problems;
}

/**
 * Required check types that cannot support any claim (for example `build`). Such a type
 * proves nothing on its own, so it belongs in `recommended`.
 */
export function unprovingRequiredChecks(contract: SkillContract, supports: ReadonlyMap<string, string[]>): string[] {
  return contract.verification.required.filter((type) => (supports.get(type) ?? []).length === 0);
}

/** Sentences of at least `minWords` words that appear in more than one skill. */
export function duplicatedSentences(skills: { id: string; text: string }[], minWords = 12): string[] {
  const owners = new Map<string, Set<string>>();
  for (const { id, text } of skills) {
    const sentences = text
      .replace(/^#.*$/gm, "")
      .split(/(?<=[.!?])\s+|\n\s*\n/)
      .map(normalize)
      .filter((sentence) => sentence.split(" ").length >= minWords);
    for (const sentence of new Set(sentences)) {
      if (!owners.has(sentence)) owners.set(sentence, new Set());
      owners.get(sentence)!.add(id);
    }
  }
  return [...owners]
    .filter(([, ids]) => ids.size > 1)
    .map(([sentence, ids]) => `"${sentence}" appears in ${[...ids].sort().join(", ")}; move it to a shared place`);
}

/** Dependency cycles among skills, required and optional edges alike, as "a -> b -> a". */
export function dependencyCycles(skills: SkillContract[]): string[] {
  const edges = new Map(
    skills.map((skill) => [skill.id, [...(skill.depends_on?.required ?? []), ...(skill.depends_on?.optional ?? [])]]),
  );
  const cycles: string[] = [];
  const done = new Set<string>();
  const visit = (id: string, path: string[]) => {
    const start = path.indexOf(id);
    if (start >= 0) {
      cycles.push([...path.slice(start), id].join(" -> "));
      return;
    }
    if (done.has(id)) return;
    for (const next of edges.get(id) ?? []) visit(next, [...path, id]);
    done.add(id);
  };
  for (const id of edges.keys()) visit(id, []);
  return cycles;
}

export interface VerificationPlan {
  required: string[];
  recommended?: string[];
  optional?: string[];
  evidence: string[];
}

export interface EvidenceRecord {
  producer?: { workflow?: string; skills?: string[] };
  plan: VerificationPlan;
  completion: { status: string };
}

/**
 * Problems with the verification plan of a record against the skills it names in
 * `producer.skills`: the plan may add requirements but never drop one a skill imposes.
 * Whether the plan was then met is decided by evaluateCompletion (evidence.ts).
 */
export function assessSkillEvidence(record: EvidenceRecord, skills: ReadonlyMap<string, SkillContract>): string[] {
  const problems: string[] = [];
  for (const id of record.producer?.skills ?? []) {
    const skill = skills.get(id);
    if (skill === undefined) {
      problems.push(`producer skill "${id}" is unknown`);
      continue;
    }
    problems.push(...planCoverageProblems(id, skill.verification, skill.evidence.required, record.plan));
  }
  return problems;
}

/**
 * Requirements `owner` imposes that `plan` drops: required check types missing from
 * `plan.required`, recommended ones missing from both lists, and required evidence kinds.
 */
export function planCoverageProblems(
  owner: string,
  verification: { required?: string[]; recommended?: string[] },
  kinds: string[],
  plan: VerificationPlan,
): string[] {
  const problems: string[] = [];
  const required = new Set(plan.required);
  const recommended = new Set([...plan.required, ...(plan.recommended ?? [])]);
  for (const type of verification.required ?? []) {
    if (!required.has(type)) problems.push(`${owner} requires ${type} checks, but the plan does not`);
  }
  for (const type of verification.recommended ?? []) {
    if (verification.required?.includes(type)) continue;
    if (!recommended.has(type)) problems.push(`${owner} recommends ${type} checks, but the plan neither requires nor recommends them`);
  }
  for (const kind of kinds) {
    if (!plan.evidence.includes(kind)) problems.push(`${owner} requires ${kind} evidence, but the plan does not`);
  }
  return problems;
}
