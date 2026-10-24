export function analyzeHarnessEvaluation(dataset: unknown): {
  evaluation_id: string;
  repository_revision: string;
  host: "claude-code" | "codex";
  host_version: string;
  baseline: { task_id: string; quality: Record<string, number>; metrics: Record<string, number | null> };
  candidates: { task_id: string; quality: Record<string, number>; metrics: Record<string, number | null>; metric_delta_percent: Record<string, number | null>; eligible: boolean }[];
  recommendation: string;
  rationale: string;
};
