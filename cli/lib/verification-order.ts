// Orders the profile's checks so that each runs after the checks it `depends_on`, keeping
// profile order wherever the dependencies allow it.

export interface OrderableCheck {
  readonly id: string;
  readonly depends_on?: readonly string[];
}

export type CheckOrder<T> =
  | { readonly ordered: T[] }
  | { readonly unresolved: { readonly check: string; readonly dependency: string }[] }
  | { readonly cycle: string[] };

export function orderChecks<T extends OrderableCheck>(checks: readonly T[]): CheckOrder<T> {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const unresolved = checks.flatMap((check) => (check.depends_on ?? [])
    .filter((dependency) => !byId.has(dependency))
    .map((dependency) => ({ check: check.id, dependency })));
  if (unresolved.length > 0) return { unresolved };

  const ordered: T[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];
  const visit = (check: T): string[] | undefined => {
    if (done.has(check.id)) return undefined;
    const open = visiting.indexOf(check.id);
    if (open >= 0) return [...visiting.slice(open), check.id];
    visiting.push(check.id);
    for (const dependency of check.depends_on ?? []) {
      const cycle = visit(byId.get(dependency)!);
      if (cycle) return cycle;
    }
    visiting.pop();
    done.add(check.id);
    ordered.push(check);
    return undefined;
  };
  for (const check of checks) {
    const cycle = visit(check);
    if (cycle) return { cycle };
  }
  return { ordered };
}
