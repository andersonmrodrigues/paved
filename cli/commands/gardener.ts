import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { analyzeGardener, GardenerInputError } from "../lib/gardener.ts";
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { gardenerProvider } from "../lib/decisions/providers/gardener.ts";
import { gardenerHandler as adoptionHandler } from "../lib/decisions/handlers/gardener.ts";

export interface ShortcutDebtEntry { path: string; line: number; limitation: string; revisit_when: string }

/** Collect explicit, read-only shortcut markers from tracked text files. */
export function collectShortcutDebt(projectRoot: string): ShortcutDebtEntry[] {
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["-C", projectRoot, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0").filter(Boolean);
  } catch {
    throw new Error("Shortcut debt requires a Git repository.");
  }
  const result: ShortcutDebtEntry[] = [];
  for (const file of tracked) {
    if (isAbsolute(file) || file.split(/[\\/]/).some((part) => part === ".." || part === "node_modules" || part === ".git")) continue;
    const absolute = join(projectRoot, file);
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size > 1_000_000) continue;
      const source = readFileSync(absolute);
      if (source.includes(0)) continue;
      source.toString("utf8").split(/\r?\n/).forEach((text, index) => {
        const match = text.match(/\bshortcut:\s*(.+?);\s*revisit when\s+(.+?)\s*$/i);
        if (match) result.push({ path: relative(projectRoot, absolute).split(sep).join("/"), line: index + 1,
          limitation: match[1]!.trim(), revisit_when: match[2]!.trim() });
      });
    } catch {
      // A tracked file can disappear between listing and reading; skip it.
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function gardenerHandler(invocation: CommandInvocation): CommandResult {
  try {
    if (invocation.selectors.length > 0) {
      if (invocation.selectors.length !== 1 || invocation.selectors[0] !== "debt") {
        throw new GardenerInputError("Use paved gardener [debt].");
      }
      return createResult({ command: "gardener", status: "success", data: {
        mode: "shortcut-debt", entries: collectShortcutDebt(invocation.paths.sourceRoot), readOnly: true,
      } });
    }
    const result = analyzeGardener(invocation.paths);
    const count = result.proposals.filter((proposal) => proposal.status === "CANDIDATE").length;
    const skippedDiagnostics = result.skipped.map(({ record, problems }) => createDiagnostic({
      severity: "warning", category: "findings", code: "PAVED_GARDENER_EVIDENCE_SKIPPED", component: "gardener",
      message: record.startsWith(".paved/generated/runs/")
        ? `Skipped ${record}: it is not a valid workflow run (${problems.join("; ")}). Its corrections are not counted.`
        : `Skipped ${record}: it contradicts its recorded observations (${problems.join("; ")}). Regenerate or remove the record.`,
    }));
    const outcome = runDecisionGate({
      context: {
        projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
        command: "gardener", answers: invocation.flags.answers,
        ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
      },
      providers: [gardenerProvider], handlers: new Map([["gardener.adopt", adoptionHandler]]),
      persist: invocation.flags.answers.length > 0,
    });
    const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
      severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID", component: "gardener", message,
    }));
    return createResult({
      command: "gardener", status: decisionDiagnostics.length > 0 ? "failed" : count > 0 || skippedDiagnostics.length > 0 ? "warning" : "success",
      decisions: outcome.projections,
      data: { ...result, dryRun: invocation.flags.dryRun, approvalRequired: true },
      diagnostics: [...decisionDiagnostics, ...skippedDiagnostics, ...(count > 0 ? [createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_GARDENER_PROPOSALS", component: "gardener",
        message: `${count} improvement proposal(s) require human review.`,
      })] : [])],
    });
  } catch (error) {
    return createResult({ command: "gardener", status: "failed", diagnostics: [createDiagnostic({
      severity: "error", category: error instanceof GardenerInputError ? "config" : "internal",
      code: error instanceof GardenerInputError ? "PAVED_GARDENER_INPUT" : "PAVED_GARDENER_FAILURE",
      component: "gardener", message: error instanceof GardenerInputError ? error.message : "Gardener analysis failed.",
    })] });
  }
}
