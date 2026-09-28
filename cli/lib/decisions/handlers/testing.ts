import type { HandlerRegistration } from "../gate.ts";

export const testingHandler: HandlerRegistration = { effect: "record-only", apply: () => [] };
