export type ModelRole = "explorer" | "implementer" | "reviewer" | "mechanical";
export type CostTier = "low" | "medium" | "high";

export interface AvailableModel {
  id: string;
  family: string | null;
  costTier: CostTier | null;
}

export interface ModelPolicyInput {
  models: readonly AvailableModel[];
  sessionFamily: string | null;
  preferences?: Partial<Record<ModelRole, string>>;
}

export interface RoleRecommendation {
  candidates: string[];
  fallback: "session";
  preference: string | null;
  preferenceStatus: "none" | "available" | "unavailable";
  requiresHumanDecision: boolean;
}

export type ReviewerFamilyConstraint =
  | "different-family-available"
  | "different-family-unavailable"
  | "different-family-unverified"
  | "implementer-family-unknown"
  | "preference-unavailable"
  | "preference-same-family"
  | "preference-family-unknown";

export type ModelRecommendations = Record<Exclude<ModelRole, "reviewer">, RoleRecommendation> & {
  reviewer: RoleRecommendation & { familyConstraint: ReviewerFamilyConstraint };
  constraints: {
    sessionFamily: string | null;
    implementerFamily: string | null;
    unknownCostModels: string[];
    unknownFamilyModels: string[];
  };
};

const costOrder: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };
const roles: readonly ModelRole[] = ["explorer", "implementer", "reviewer", "mechanical"];

function validName(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function compareModels(a: AvailableModel, b: AvailableModel): number {
  const costDifference = (a.costTier === null ? 3 : costOrder[a.costTier])
    - (b.costTier === null ? 3 : costOrder[b.costTier]);
  return costDifference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Recommends only host-reported models; it never switches the active model. */
export function recommendModels(input: ModelPolicyInput): ModelRecommendations {
  const byId = new Map<string, AvailableModel>();
  if (input.sessionFamily !== null && !validName(input.sessionFamily)) {
    throw new Error("session family must be a nonempty, trimmed string or null");
  }
  for (const model of input.models) {
    if (!validName(model.id)) throw new Error("model id must be a nonempty, trimmed string");
    if (model.id === "session") throw new Error("session is reserved for the fallback");
    if (byId.has(model.id)) throw new Error(`duplicate model id: ${model.id}`);
    if (model.family !== null && !validName(model.family)) throw new Error("model family must be a nonempty, trimmed string or null");
    if (model.costTier !== null && !Object.hasOwn(costOrder, model.costTier)) throw new Error("invalid cost tier");
    byId.set(model.id, model);
  }
  for (const role of roles) {
    const preference = input.preferences?.[role];
    if (preference !== undefined && !validName(preference)) throw new Error(`${role} preference must be a nonempty, trimmed string`);
  }

  const sorted = [...input.models].sort(compareModels);
  function recommendation(role: ModelRole, candidates: string[]): RoleRecommendation {
    const preference = input.preferences?.[role] ?? null;
    const preferenceStatus = preference === null ? "none"
      : preference === "session" || byId.has(preference) ? "available" : "unavailable";
    const ordered = preferenceStatus === "unavailable" || preference === "session"
      ? ["session"]
      : preference === null
        ? [...candidates, "session"]
        : [preference, ...candidates.filter((id) => id !== preference), "session"];
    return {
      candidates: ordered,
      fallback: "session",
      preference,
      preferenceStatus,
      requiresHumanDecision: preferenceStatus === "unavailable",
    };
  }

  const implementer = recommendation("implementer", []);
  const implementerFamily = implementer.requiresHumanDecision ? null
    : implementer.candidates[0] === "session" ? input.sessionFamily
      : byId.get(implementer.candidates[0]!)?.family ?? null;
  const otherFamily = (model: AvailableModel): boolean =>
    implementerFamily !== null && model.family !== null && model.family !== implementerFamily;
  const sessionIsOtherFamily = implementerFamily !== null && input.sessionFamily !== null
    && input.sessionFamily !== implementerFamily;
  const reviewerModels = [...sorted].sort((a, b) => Number(otherFamily(b)) - Number(otherFamily(a)));
  const reviewerCandidates = sessionIsOtherFamily && !sorted.some(otherFamily) ? [] : reviewerModels.map((model) => model.id);
  const reviewer = recommendation("reviewer", reviewerCandidates);
  const reviewerPreference = reviewer.preferenceStatus === "available" ? reviewer.preference : null;
  const preferredFamily = reviewerPreference === "session" ? input.sessionFamily
    : reviewerPreference === null ? null : byId.get(reviewerPreference)?.family ?? null;
  let familyConstraint: ReviewerFamilyConstraint;
  if (implementerFamily === null) familyConstraint = "implementer-family-unknown";
  else if (reviewer.preferenceStatus === "unavailable") familyConstraint = "preference-unavailable";
  else if (reviewerPreference !== null && preferredFamily === null) familyConstraint = "preference-family-unknown";
  else if (reviewerPreference !== null && preferredFamily === implementerFamily) familyConstraint = "preference-same-family";
  else if (sorted.some(otherFamily) || sessionIsOtherFamily) familyConstraint = "different-family-available";
  else if (input.sessionFamily === null || sorted.some((model) => model.family === null)) familyConstraint = "different-family-unverified";
  else familyConstraint = "different-family-unavailable";

  return {
    explorer: recommendation("explorer", sorted.map((model) => model.id)),
    implementer,
    reviewer: { ...reviewer, familyConstraint },
    mechanical: recommendation("mechanical", sorted.map((model) => model.id)),
    constraints: {
      sessionFamily: input.sessionFamily,
      implementerFamily,
      unknownCostModels: sorted.filter((model) => model.costTier === null).map((model) => model.id).sort(),
      unknownFamilyModels: sorted.filter((model) => model.family === null).map((model) => model.id).sort(),
    },
  };
}
