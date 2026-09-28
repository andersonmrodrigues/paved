import { planProjection } from "../shared/projection.ts";
export const codexIntegration = (projectRoot: string, coreRoot: string) => planProjection("codex", projectRoot, coreRoot);
