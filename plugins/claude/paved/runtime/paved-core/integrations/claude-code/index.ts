import { planProjection } from "../shared/projection.ts";
export const claudeCodeIntegration = (projectRoot: string, coreRoot: string) => planProjection("claude-code", projectRoot, coreRoot);
