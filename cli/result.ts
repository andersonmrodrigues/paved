export const EXIT_CODES = {
  success: 0,
  findings: 1,
  usage: 2,
  environment: 3,
  config: 4,
  resolution: 5,
  "generation/update": 6,
  verification: 7,
  conflict: 8,
  internal: 9,
} as const;

export type ExitCategory = keyof typeof EXIT_CODES;
export type DiagnosticCategory = Exclude<ExitCategory, "success">;

export type DiagnosticSeverity = "info" | "warning" | "error";

export type ResultStatus = "success" | "warning" | "failed";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly category: DiagnosticCategory;
  readonly code: string;
  readonly component: string;
  readonly message: string;
  readonly remediation?: string;
}

export interface CommandResult<TData = unknown> {
  readonly command: string;
  readonly status: ResultStatus;
  readonly data?: TData;
  readonly diagnostics: readonly Diagnostic[];
}

type DiagnosticInput = Omit<Diagnostic, "category"> & {
  readonly category: DiagnosticCategory;
};

type ResultInput<TData> = {
  readonly command: string;
  readonly status: ResultStatus;
  readonly data?: TData;
  readonly diagnostics?: readonly Diagnostic[];
};

const CATEGORY_PRECEDENCE: Record<ExitCategory, number> = {
  success: 0,
  findings: 1,
  usage: 2,
  environment: 3,
  config: 4,
  resolution: 5,
  "generation/update": 6,
  verification: 7,
  conflict: 8,
  internal: 9,
};

export function createDiagnostic(input: DiagnosticInput): Diagnostic {
  const diagnostic: Diagnostic = {
    severity: input.severity,
    category: input.category,
    code: input.code,
    component: input.component,
    message: input.message,
  };

  return input.remediation === undefined
    ? diagnostic
    : { ...diagnostic, remediation: input.remediation };
}

function hasBlockingDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.category !== "findings");
}

export function createResult<TData = unknown>(input: ResultInput<TData>): CommandResult<TData> {
  const diagnostics = input.diagnostics ?? [];
  const normalizedDiagnostics = input.status === "failed" && !hasBlockingDiagnostic(diagnostics)
    ? [
        ...diagnostics,
        createDiagnostic({
          severity: "error",
          category: "internal",
          code: "PAVED_RESULT_MALFORMED_FAILURE",
          component: "cli.result",
          message: "Malformed failed result: failed status requires at least one blocking diagnostic.",
          remediation: "Add a diagnostic category other than findings for failed command results.",
        }),
      ]
    : diagnostics;
  const base = {
    command: input.command,
    status: input.status,
    diagnostics: normalizedDiagnostics,
  };

  return input.data === undefined ? base : { ...base, data: input.data };
}

export function primaryCategory(result: CommandResult): ExitCategory {
  let primary: ExitCategory = result.status === "success" ? "success" : "findings";

  for (const diagnostic of result.diagnostics) {
    if (CATEGORY_PRECEDENCE[diagnostic.category] > CATEGORY_PRECEDENCE[primary]) {
      primary = diagnostic.category;
    }
  }

  return primary;
}

export function exitCode(result: CommandResult): number {
  return EXIT_CODES[primaryCategory(result)];
}
