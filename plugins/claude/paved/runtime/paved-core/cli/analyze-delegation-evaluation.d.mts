interface MetricComparison {
  sequential_median: number | null;
  delegated_median: number | null;
  paired_median_delta_percent: number | null;
  missing: boolean;
}

interface StrategyQuality {
  success_rate: number;
  acceptance_pass_ratio: number;
  retries_median: number;
}

export interface DelegationEvaluationSummary {
  schema_version: 1;
  scenario_id: string;
  repository_revision: string;
  host: "claude-code" | "codex";
  host_version: string;
  repetitions: number;
  quality: {
    sequential: StrategyQuality;
    delegated: StrategyQuality;
    median_paired_acceptance_delta_percentage_points: number;
  };
  duration_ms: MetricComparison;
  tokens_input_output: MetricComparison;
  reasoning_tokens: MetricComparison;
  cost_usd: MetricComparison;
  retries: MetricComparison;
  interpretation: string;
}

export function analyzeEvaluation(dataset: unknown): DelegationEvaluationSummary;
