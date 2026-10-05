export type AgentCommandLifecycleState =
  | "UNINITIALIZED" | "INITIALIZED" | "RESOLVED" | "GENERATED"
  | "VALIDATED" | "READY" | "STALE" | "INCOMPATIBLE" | "BROKEN";

export type AgentCommandGroup = "development" | "management";

export interface AgentCommandContract {
  readonly id: `paved.${string}`;
  readonly name: string;
  readonly group: AgentCommandGroup;
  readonly description: string;
  readonly input: { readonly required: boolean; readonly description: string };
  readonly output: string;
  readonly requiredContext: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly allowedSideEffects: readonly string[];
  readonly lifecycle: readonly AgentCommandLifecycleState[];
  readonly tool?: string;
  readonly cliCommand: string;
  readonly failureSemantics: readonly string[];
  readonly interaction: "conversational" | "read-only";
  readonly decisionSources: readonly ("runtime" | "agent")[];
  readonly answerChannels: readonly ("relayed" | "human-authored")[];
}

export interface DiscoveredAgentCommand extends AgentCommandContract {
  readonly available: boolean;
  readonly reason?: string;
  readonly recommendedNextAction?: string;
}

type AgentCommandDefinition = Omit<AgentCommandContract, "requiredCapabilities"> &
  Partial<Pick<AgentCommandContract, "requiredCapabilities">>;

const MANAGEMENT_STATES: readonly AgentCommandLifecycleState[] = [
  "INITIALIZED", "RESOLVED", "GENERATED", "VALIDATED", "READY", "STALE", "INCOMPATIBLE", "BROKEN",
];
const DEVELOPMENT_STATES: readonly AgentCommandLifecycleState[] = ["RESOLVED", "GENERATED", "VALIDATED", "READY"];

const COMMAND_DEFINITIONS: readonly AgentCommandDefinition[] = [
  {
    id: "paved.init", name: "init", group: "management",
    description: "Initialize Paved and prepare repository context and verification. Use when setting up Paved in a repository that is not initialized.",
    input: { required: false, description: "No arguments." },
    output: "Initialization result, detected adapters, lifecycle state, and diagnostics.",
    requiredContext: [".paved/manifest.yaml", "repository evidence"],
    allowedSideEffects: [".paved/ initialization state", "generated project context", "managed AGENTS.md block"],
    lifecycle: ["UNINITIALIZED"], cliCommand: "init",
    interaction: "conversational", decisionSources: ["runtime"], answerChannels: ["relayed"],
    failureSemantics: ["Existing Paved state is never reset.", "Invalid partial state fails with diagnostics.", "Package acquisition and runtime activation require verified integrity."],
  },
  {
    id: "paved.status", name: "status", group: "management",
    description: "Inspect Paved setup, diagnostics and open runs, then offer safe repairs. Use when checking readiness or deciding whether a reported Paved problem needs repair.",
    input: { required: false, description: "No arguments; answer a repair decision with --answer." },
    output: "Consumer inspection, actionable diagnostics, open runs, and repair decisions.",
    requiredContext: [".paved/manifest.yaml", ".paved/paved.lock"],
    allowedSideEffects: ["none unless the user answers a repair decision", "the repair the user chose"],
    lifecycle: ["UNINITIALIZED", ...MANAGEMENT_STATES], cliCommand: "status",
    interaction: "conversational", decisionSources: ["runtime"], answerChannels: ["human-authored"],
    failureSemantics: ["Missing and invalid state is reported without writes.", "No repair is applied without the user's answer."],
  },
  {
    id: "paved.intent", name: "intent", group: "development",
    description: "Start a repository change by classifying its type and recording the request before planning. Use when the user asks to begin a feature, bug fix or refactor.",
    input: { required: true, description: "The user's request, verbatim; classify with --workflow <id> --because <evidence>, or let the user decide." },
    output: "The run, its Intent document, its classification or the decision that settles it, and context and discovery results.",
    requiredContext: [".paved/manifest.yaml", ".paved/project/", ".paved/rules/", "core workflows"],
    allowedSideEffects: [".paved/generated/runs/", ".paved/documents/intents/", "disposable Paved evidence"],
    lifecycle: DEVELOPMENT_STATES, cliCommand: "intent",
    interaction: "conversational", decisionSources: ["runtime", "agent"], answerChannels: ["relayed"],
    failureSemantics: ["A workflow choice without evidence is refused.", "When the kind of change is uncertain, the user decides; Paved never guesses.", "A bug needs a failing regression test and a refactor a passing baseline before planning."],
  },
  {
    id: "paved.plan", name: "plan", group: "development",
    description: "Draft and preview a plan for an open Intent, then record the user's explicit approval. Use when an Intent is ready for planning.",
    input: { required: false, description: "The run, when several are open (--run <id>)." },
    output: "The plan awaiting approval, its review block, and the approval outcome.",
    requiredContext: [".paved/project/", ".paved/rules/", "the run's workflow", "verification profile"],
    allowedSideEffects: [".paved/documents/plans/", ".paved/approvals/", ".paved/generated/runs/"],
    lifecycle: DEVELOPMENT_STATES, cliCommand: "plan",
    interaction: "conversational", decisionSources: ["runtime", "agent"], answerChannels: ["relayed"],
    failureSemantics: ["A plan file and summary are required before approval.", "A changed plan needs a new approval.", "Only the user approves, in the conversation."],
  },
  {
    id: "paved.execute", name: "execute", group: "development",
    description: "Carry out the approved plan, run required checks and record review evidence. Use when the user-approved plan is ready to implement.",
    input: { required: false, description: "The run, when several are open (--run <id>)." },
    output: "Change, test and verification evidence, review document, completion, and new gardener proposals.",
    requiredContext: [".paved/project/", ".paved/rules/", "the run's workflow", "verification profile", "tool bindings"],
    requiredCapabilities: ["testing-run"],
    allowedSideEffects: ["planned application changes", "durable Paved work documents under .paved/documents/", "disposable Paved evidence"],
    lifecycle: DEVELOPMENT_STATES, cliCommand: "execute",
    interaction: "conversational", decisionSources: ["runtime", "agent"], answerChannels: ["relayed", "human-authored"],
    failureSemantics: ["A run without an approved plan is refused.", "Failed tests or verification fail the phase; retries are bounded.", "Gardener proposals are advisory and never block completion."],
  },
  {
    id: "paved.preview", name: "preview", group: "development",
    description: "Open a local review of Markdown documents and collect comments on selected text. Use when the user wants to review or comment on documents before approving them.",
    input: { required: true, description: "A Markdown file or a folder of Markdown files, and a preview operation." },
    output: "Loopback preview URL, the reviewed documents, and comments with their document, status and revision.",
    requiredContext: ["Markdown file or folder in the project"],
    allowedSideEffects: ["local loopback preview server", ".paved/generated/previews/"],
    lifecycle: DEVELOPMENT_STATES, cliCommand: "preview",
    interaction: "conversational", decisionSources: [], answerChannels: [],
    failureSemantics: ["A comment on a stale document version is refused.", "The preview approves nothing; approvals and confirmations are asked in the conversation.", "A folder with no Markdown files, or more than the limit, is refused."],
  },
  {
    id: "paved.update", name: "update", group: "management",
    description: "Plan and apply a compatible local Paved Core, adapter or input update. Use when the user asks to update initialized Paved state.",
    input: { required: false, description: "No arguments." },
    output: "Compatibility result, planned changes, lock result, and diagnostics.",
    requiredContext: [".paved/manifest.yaml", ".paved/paved.lock"],
    allowedSideEffects: ["Paved lock through update transaction", "affected generated context and proposals"],
    lifecycle: MANAGEMENT_STATES, cliCommand: "update",
    interaction: "conversational", decisionSources: ["runtime"], answerChannels: ["relayed"],
    failureSemantics: [
      "Unknown compatibility, migration requirements, and ownership conflicts stop before unsafe writes.",
      "Remote updates remain unsupported.",
      "When the plugin carries a newer runtime than paved.lock pins, update verifies and activates it inside the update transaction and rewrites the lock; `runtime rollback` restores the previous runtime and lock. The same or an older plugin runtime never changes the pin.",
    ],
  },
];

export const AGENT_COMMANDS: readonly AgentCommandContract[] = COMMAND_DEFINITIONS.map((command) => ({
  ...command,
  requiredCapabilities: command.requiredCapabilities ?? [],
}));
