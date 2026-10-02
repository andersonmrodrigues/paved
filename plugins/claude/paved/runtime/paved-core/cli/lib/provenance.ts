// Provenance validation that JSON Schema cannot express: every source a statement cites
// must be declared in the document's provenance, and managed blocks in Markdown must be
// well formed. Run after schema validation.
//
// Managed block grammar (one marker per line):
//   <!-- paved:begin generated id=<name> sources=<id>[,<id>...] [confidence=<value>] -->
//   <!-- paved:end generated -->
//   <!-- paved:begin managed -->   (maintained by the CLI, for example in AGENTS.md)
//   <!-- paved:end managed -->

const BEGIN = /^<!-- paved:begin (generated|managed)((?: [a-z_]+=[^\s]+)*) -->$/;
const END = /^<!-- paved:end (generated|managed) -->$/;
const CONFIDENCE = new Set(["observed", "declared", "inferred"]);

export interface ManagedBlock {
  type: "generated" | "managed";
  attributes: Record<string, string>;
  line: number;
}

export function parseManagedBlocks(body: string): { blocks: ManagedBlock[]; problems: string[] } {
  const blocks: ManagedBlock[] = [];
  const problems: string[] = [];
  let open: ManagedBlock | undefined;
  body.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    const trimmed = text.trim();
    if (!trimmed.startsWith("<!-- paved:")) return;
    const begin = BEGIN.exec(trimmed);
    const end = END.exec(trimmed);
    if (begin) {
      if (open) problems.push(`line ${line}: block opened inside the block opened on line ${open.line}`);
      const attributes = Object.fromEntries(
        (begin[2] ?? "").trim().split(" ").filter(Boolean).map((pair) => pair.split("=", 2) as [string, string]),
      );
      open = { type: begin[1] as ManagedBlock["type"], attributes, line };
      blocks.push(open);
    } else if (end) {
      if (!open) problems.push(`line ${line}: end marker without a block`);
      else if (open.type !== end[1]) problems.push(`line ${line}: "${end[1]}" end marker closes a ${open.type} block`);
      open = undefined;
    } else {
      problems.push(`line ${line}: malformed Paved marker`);
    }
  });
  if (open) problems.push(`line ${open.line}: block is never closed`);
  return { blocks, problems };
}

interface TracedDocument {
  provenance?: { sources: { id?: string }[] };
  conflicts?: { statements: { source: string }[] }[];
}

/** Problems with the citations in a context document or feature entry (and its Markdown body, if any). */
export function assessProvenance(document: TracedDocument, body = ""): string[] {
  const problems: string[] = [];
  const declared = (document.provenance?.sources ?? []).map((source) => source.id ?? "");
  const known = new Set(declared);
  if (known.size !== declared.length) {
    problems.push("provenance declares a source id more than once");
  }
  const cite = (where: string, id: string) => {
    if (!known.has(id)) problems.push(`${where} cites source "${id}", which provenance does not declare`);
  };

  (document.conflicts ?? []).forEach((conflict, index) => {
    for (const statement of conflict.statements) cite(`conflict ${index + 1}`, statement.source);
  });

  const { blocks, problems: markerProblems } = parseManagedBlocks(body);
  problems.push(...markerProblems);
  const blockIds = new Set<string>();
  for (const block of blocks.filter((b) => b.type === "generated")) {
    const { id, sources, confidence } = block.attributes;
    const where = `block on line ${block.line}`;
    if (!id) problems.push(`${where} has no id`);
    else if (blockIds.has(id)) problems.push(`${where} repeats block id "${id}"`);
    else blockIds.add(id);
    if (!sources) problems.push(`${where} cites no sources`);
    for (const source of sources?.split(",") ?? []) cite(where, source);
    if (confidence !== undefined && !CONFIDENCE.has(confidence)) {
      problems.push(`${where} has unknown confidence "${confidence}"`);
    }
  }
  return problems;
}
