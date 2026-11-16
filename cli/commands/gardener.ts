import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { analyzeGardener, GardenerInputError } from "../lib/gardener.ts";
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { correctionProvider, gardenerProvider } from "../lib/decisions/providers/gardener.ts";
import { GardenerHandlers } from "../lib/decisions/handlers/gardener.ts";
import { correctionProposals, proposeCorrection, type CorrectionResult } from "../lib/gardener-corrections.ts";

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

function decisionContext(invocation: CommandInvocation) {
  return {
    projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
    command: "gardener", answers: invocation.flags.answers,
    ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
  };
}

const CORRECTION_MESSAGES: Readonly<Record<CorrectionResult["outcome"], (result: CorrectionResult) => string>> = {
  proposed: (result) => `Proposed ${result.rule_id} in ${result.proposal}. Ask the person whether to adopt it; nothing enforces it until they do.`,
  merged: (result) => `The correction restates ${result.rule_id}; its proposal ${result.proposal} now records ${result.occurrences} statements. Ask the person whether to adopt it.`,
  duplicate: (result) => `The correction restates ${result.duplicate_of!.origin} rule ${result.rule_id} (${result.duplicate_of!.path}); no proposal was written. If that rule keeps being broken, it needs a stronger enforcement layer: use the gardener skill.`,
};

/** `paved gardener correction`: a person's correction, verbatim, becomes a rule proposal for that person to adopt. */
function correctionHandler(invocation: CommandInvocation): CommandResult {
  const { text, correctionEvidence, dryRun } = invocation.flags;
  if (text === undefined) throw new GardenerInputError("Pass the person's words verbatim with --text and the mistake they correct with --evidence.");
  const result = proposeCorrection({
    projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
    text, evidence: correctionEvidence, dryRun,
  });
  const outcome = dryRun ? undefined : runDecisionGate({
    context: decisionContext(invocation), providers: [correctionProvider], handlers: new GardenerHandlers(), persist: false,
  });
  return createResult({
    command: "gardener",
    status: "warning",
    decisions: (outcome?.projections ?? []).filter((decision) => decision.evidence.some((item) => item.location === result.proposal)),
    data: { mode: "correction", ...result, dryRun, approvalRequired: true },
    diagnostics: [createDiagnostic({
      severity: "warning", category: "findings", component: "gardener",
      code: result.outcome === "duplicate" ? "PAVED_GARDENER_CORRECTION_DUPLICATE" : "PAVED_GARDENER_CORRECTION_PROPOSED",
      message: CORRECTION_MESSAGES[result.outcome](result),
    })],
  });
}

export function gardenerHandler(invocation: CommandInvocation): CommandResult {
  try {
    if (invocation.selectors[0] === "correction" && invocation.selectors.length === 1) return correctionHandler(invocation);
    if (invocation.flags.text !== undefined || invocation.flags.correctionEvidence.length > 0) {
      throw new GardenerInputError("--text and --evidence are supported only by paved gardener correction.");
    }
    if (invocation.selectors.length > 0) {
      if (invocation.selectors.length !== 1 || invocation.selectors[0] !== "debt") {
        throw new GardenerInputError("Use paved gardener [debt | correction --text <words> --evidence <ref>].");
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
      context: decisionContext(invocation),
      providers: [gardenerProvider, correctionProvider], handlers: new GardenerHandlers(),
      persist: invocation.flags.answers.length > 0,
    });
    const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
      severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID", component: "gardener", message,
    }));
    const corrections = correctionProposals(invocation.paths.projectRoot, invocation.paths.coreRoot);
    const pending = count + corrections.length;
    return createResult({
      command: "gardener", status: decisionDiagnostics.length > 0 ? "failed" : pending > 0 || skippedDiagnostics.length > 0 ? "warning" : "success",
      decisions: outcome.projections,
      data: { ...result, corrections, applied: outcome.applied.flatMap((decision) => decision.applied_changes ?? []),
        dryRun: invocation.flags.dryRun, approvalRequired: true },
      diagnostics: [...decisionDiagnostics, ...skippedDiagnostics, ...(pending > 0 ? [createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_GARDENER_PROPOSALS", component: "gardener",
        message: `${pending} improvement proposal(s) require human review${corrections.length > 0 ? `, ${corrections.length} of them stated corrections` : ""}.`,
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
