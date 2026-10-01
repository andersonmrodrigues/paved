import type { AnswerValue } from "../answers.ts";
import type { DecisionContext, HandlerRegistration } from "../gate.ts";
import { runGeneratorsUnderExistingOperationLock } from "../../generator-runtime.ts";

function apply(answer: AnswerValue, context: DecisionContext): readonly string[] {
  if (answer === "skip") return [];
  if (answer !== "apply") throw new Error(`Unknown repair option: ${String(answer)}.`);
  const run = runGeneratorsUnderExistingOperationLock(context.coreRoot, context.projectRoot);
  const errors = run.executions.flatMap((execution) => execution.errors.map((error) => `${execution.generator}: ${error}`));
  if (errors.length > 0) throw new Error(`Context repair failed: ${errors.join("; ")}`);
  return [...new Set(run.executions.flatMap((execution) => [...execution.outputs, ...execution.proposals]))]
    .sort((a, b) => a.localeCompare(b, "en"));
}

export const repairHandler: HandlerRegistration = {
  effect: "repository-mutating", apply, reject: (answer) => answer === "skip",
};
