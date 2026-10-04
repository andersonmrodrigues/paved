import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { resolveSafePath } from "./safe-path.ts";

const AGENTS_PATH = "AGENTS.md";
const BEGIN = "<!-- paved:begin managed -->";
const END = "<!-- paved:end managed -->";

export type AgentsBlockResult =
  | { readonly status: "created" | "updated" | "unchanged" }
  | { readonly status: "invalid"; readonly reason: string };

function managedBlock(coreRoot: string): string {
  return readFileSync(join(coreRoot, "core/templates/AGENTS.md"), "utf8").trimEnd();
}

export function agentsBlockState(coreRoot: string, projectRoot: string): "absent" | "current" | "outdated" | "invalid" {
  const path = resolveSafePath(projectRoot, AGENTS_PATH);
  if (!existsSync(path)) return "absent";
  const current = readFileSync(path, "utf8");
  const begin = current.indexOf(BEGIN);
  if (begin === -1) return "absent";
  const end = current.indexOf(END, begin);
  if (end === -1) return "invalid";
  return current.slice(begin, end + END.length) === managedBlock(coreRoot) ? "current" : "outdated";
}

/** Rewrites an existing managed block to the current template; never creates one. */
export function refreshAgentsBlock(coreRoot: string, projectRoot: string): AgentsBlockResult {
  const state = agentsBlockState(coreRoot, projectRoot);
  if (state === "invalid") return { status: "invalid", reason: "AGENTS.md has a Paved begin marker without an end marker." };
  return state === "outdated" ? ensureAgentsBlock(coreRoot, projectRoot) : { status: "unchanged" };
}

/**
 * Maintains the delimited Paved block in the root AGENTS.md: creates the file when it is
 * missing, appends the block when absent and replaces only the block when present.
 * Text outside the block is never changed.
 */
export function ensureAgentsBlock(coreRoot: string, projectRoot: string): AgentsBlockResult {
  const block = managedBlock(coreRoot);
  const path = resolveSafePath(projectRoot, AGENTS_PATH);
  const exists = existsSync(path);
  const current = exists ? readFileSync(path, "utf8") : "";
  const begin = current.indexOf(BEGIN);
  const end = begin === -1 ? -1 : current.indexOf(END, begin);
  if (begin !== -1 && end === -1) {
    return { status: "invalid", reason: "AGENTS.md has a Paved begin marker without an end marker." };
  }
  const next = begin !== -1
    ? `${current.slice(0, begin)}${block}${current.slice(end + END.length)}`
    : current.trim() === "" ? `${block}\n` : `${current.trimEnd()}\n\n${block}\n`;
  if (next === current) return { status: "unchanged" };
  atomicWriteFileSync(path, next);
  return { status: exists ? "updated" : "created" };
}
