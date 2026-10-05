import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { applyProjection, metadata, planProjection, removeProjection } from "../../integrations/shared/projection.ts";
import { AGENT_COMMANDS } from "../../integrations/shared/commands.ts";
import { at } from "../helpers.ts";

const coreRoot = at(".");

describe("agent projections", () => {
  describe("conversational contract parity", () => {
    it("emits the same conversational interaction for Codex and Claude Code", async () => {
      const { renderCommand } = await import("../../integrations/shared/projection.ts");
      const command = AGENT_COMMANDS.find((item) => item.name === "execute")!;
      const codex = renderCommand(command, {
        headerLine: "<!-- h -->", title: "$paved-execute",
        launcher: { command: "node bootstrap.mjs" },
        frontmatter: { name: "paved-execute", description: command.description },
      });
      const claude = renderCommand(command, {
        headerLine: "<!-- h -->", title: "/paved:execute", launcher: { command: "node bootstrap.mjs" },
      });
      for (const text of [codex, claude]) {
        assert.match(text, /awaiting_input/);
        assert.match(text, /--answer <decision-id>=<value>/);
        assert.match(text, /--answered-by/);
        assert.match(text, /core\.decisions\.decisions/);
      }
    });

    it("references the skill instead of repeating its prohibitions", async () => {
      const { renderCommand } = await import("../../integrations/shared/projection.ts");
      const command = AGENT_COMMANDS.find((item) => item.name === "execute")!;
      const text = renderCommand(command, { headerLine: "<!-- h -->", title: "/paved:execute", launcher: { command: "node b.mjs" } });
      assert.doesNotMatch(text, /Never answer a material decision/);
    });

    it("ships exactly the seven agent commands and declares decision sources", () => {
      assert.deepEqual(AGENT_COMMANDS.map((item) => item.name), ["init", "status", "intent", "plan", "execute", "preview", "update"]);
      assert.equal(AGENT_COMMANDS.find((item) => item.name === "status")!.interaction, "conversational");
      assert.deepEqual(AGENT_COMMANDS.find((item) => item.name === "status")!.decisionSources, ["runtime"]);
      assert.deepEqual(AGENT_COMMANDS.find((item) => item.name === "intent")!.decisionSources, ["runtime", "agent"]);
      assert.equal(metadata("codex", at(".")).version, "2.0.0");
    });

    it("directs the plan step to the durable canonical plan file and its review", async () => {
      const { renderCommand } = await import("../../integrations/shared/projection.ts");
      const command = AGENT_COMMANDS.find((item) => item.name === "plan")!;
      const text = renderCommand(command, { headerLine: "<!-- h -->", title: "/paved:plan", launcher: { command: "node b.mjs" } });
      assert.ok(text.includes(".paved/documents/plans/<run-id>.md"));
    assert.ok(text.includes(".paved/documents/intents/<run-id>.md"), "the plan starts from the run's Intent document");
      assert.ok(text.includes("paved plan --run <run-id> --approve --json"));
    });
  });

  it("renders deterministic Codex and Claude projections from the same canonical skills", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    try {
      const codex = planProjection("codex", project, at("."));
      const claude = planProjection("claude-code", project, at("."));
      assert.deepEqual(
        codex.files.filter((file) => file.relativePath.endsWith("SKILL.md")).map((file) => file.relativePath.split("/").at(-2)),
        claude.files.filter((file) => file.relativePath.endsWith("SKILL.md")).map((file) => file.relativePath.split("/").at(-2)),
      );
      const codexCommands = codex.files.filter((file) => file.relativePath.includes("paved-") && file.relativePath.endsWith("SKILL.md"));
      const claudeCommands = claude.files.filter((file) => file.relativePath.includes(`${join(".claude", "commands", "paved")}${process.platform === "win32" ? "\\" : "/"}`));
      assert.equal(codexCommands.length, AGENT_COMMANDS.length);
      assert.equal(claudeCommands.length, AGENT_COMMANDS.length);
      for (const command of AGENT_COMMANDS) {
        const codexFile = codexCommands.find((file) => basename(dirname(file.relativePath)) === `paved-${command.name}`)!;
        const claudeFile = claudeCommands.find((file) => basename(file.relativePath) === `${command.name}.md`)!;
        assert.match(codexFile.content, new RegExp(`name: paved-${command.name}`));
        assert.match(claudeFile.content, new RegExp(`/paved:${command.name}`));
        assert.ok(codexFile.content.includes(command.description));
        assert.ok(claudeFile.content.includes(command.description));
        assert.deepEqual(
          codexFile.content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
          claudeFile.content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
        );
      }
      const skill = codex.files.find((file) => file.relativePath.endsWith("SKILL.md"))!;
      assert.match(skill.content, /^---\s*\n[\s\S]*?\n---\s*\n<!-- Generated by Paved /);
      assert.equal(codex.files.some((file) => file.content.includes("bootstrap.mjs verify --json")), true);
      for (const gone of ["feature", "doctor", "test", "verify", "gardener"]) {
        assert.equal(codexCommands.some((file) => basename(dirname(file.relativePath)) === `paved-${gone}`), false, gone);
        assert.equal(claudeCommands.some((file) => basename(file.relativePath) === `${gone}.md`), false, gone);
      }
      const plugin = JSON.parse(claude.files.find((file) => file.relativePath === ".claude-plugin/plugin.json")!.content) as {
        description: string;
        _paved?: unknown;
      };
      assert.match(plugin.description, /^Paved agent skills\. Generated by Paved integration /);
      assert.equal(plugin._paved, undefined);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("is idempotent and protects manually edited generated files", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    try {
      const plan = planProjection("codex", project, at("."));
      const first = applyProjection(plan);
      const second = applyProjection(plan);
      assert.equal(first.changed, plan.files.length);
      assert.equal(second.changed, 0);
      assert.equal(second.unchanged, plan.files.length);
      const target = join(plan.integration.root, plan.files[0]!.relativePath);
      writeFileSync(target, "human content\n");
      assert.throws(() => applyProjection(plan), /user-owned/);
      assert.equal(removeProjection(plan), plan.files.length - 1);
      assert.equal(readFileSync(target, "utf8"), "human content\n");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preflights every projected file before writing when a later command is user-owned", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    try {
      const plan = planProjection("codex", project, at("."));
      const firstPath = join(plan.integration.root, plan.files[0]!.relativePath);
      const owned = plan.files.at(-1)!;
      const ownedPath = join(plan.integration.root, owned.relativePath);
      mkdirSync(dirname(ownedPath), { recursive: true });
      writeFileSync(ownedPath, "human-owned command\n");

      assert.throws(() => applyProjection(plan), /user-owned/);
      assert.equal(existsSync(firstPath), false);
      assert.equal(readFileSync(ownedPath, "utf8"), "human-owned command\n");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("refuses to install through a symlinked projection parent", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    const outside = mkdtempSync(join(tmpdir(), "paved-integration-outside-"));
    try {
      symlinkSync(outside, join(project, ".agents"));
      const plan = planProjection("codex", project, at("."));

      assert.throws(() => applyProjection(plan), /symbolic link/i);
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to uninstall files through a symlinked projection parent", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    const outside = mkdtempSync(join(tmpdir(), "paved-integration-outside-"));
    const plan = planProjection("codex", project, at("."));
    const first = plan.files[0]!;
    const externalFile = join(outside, first.relativePath);
    try {
      mkdirSync(dirname(externalFile), { recursive: true });
      writeFileSync(externalFile, first.content);
      symlinkSync(outside, join(project, ".agents"));

      assert.throws(() => removeProjection(plan), /symbolic link/i);
      assert.equal(existsSync(externalFile), true);
      assert.equal(readFileSync(externalFile, "utf8"), first.content);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("updates Claude plugin descriptors generated by the earlier projection format", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    const pluginPath = join(project, ".claude-plugin", "plugin.json");
    try {
      mkdirSync(dirname(pluginPath), { recursive: true });
      writeFileSync(pluginPath, `${JSON.stringify({
        name: "paved",
        version: "1.0.0",
        description: "Paved engineering skills",
        skills: "./skills",
        _paved: { generated: true, integration: "paved.integration.claude-code" },
      })}\n`);
      const plan = planProjection("claude-code", project, at("."));

      applyProjection(plan);

      const descriptor = JSON.parse(readFileSync(pluginPath, "utf8")) as { description: string; _paved?: unknown };
      assert.match(descriptor.description, /^Paved agent skills\. Generated by Paved integration /);
      assert.equal(descriptor._paved, undefined);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("prune removes Paved-generated command files the plan no longer has, on both hosts", () => {
    for (const agent of ["claude-code", "codex"] as const) {
      const root = mkdtempSync(join(tmpdir(), `paved-prune-${agent}-`));
      try {
        const plan = planProjection(agent, root, coreRoot);
        const stale = agent === "codex" ? join(root, ".agents/skills/paved-feature/SKILL.md") : join(root, ".claude/commands/paved/feature.md");
        mkdirSync(dirname(stale), { recursive: true });
        writeFileSync(stale, "<!-- Generated by Paved paved.integration.x@1.0.0; edit the canonical skill in Paved Core instead. -->\n# old\n");
        const result = applyProjection(plan);
        assert.equal(existsSync(stale), false, `${agent}: stale command kept`);
        assert.ok(result.removed >= 1);
        if (agent === "codex") assert.equal(existsSync(dirname(stale)), false, "empty skill directory kept");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it("prune leaves user-owned files", () => {
    const root = mkdtempSync(join(tmpdir(), "paved-prune-user-"));
    try {
      const own = join(root, ".claude/commands/paved/feature.md");
      mkdirSync(dirname(own), { recursive: true });
      writeFileSync(own, "# My own feature command\n");
      applyProjection(planProjection("claude-code", root, coreRoot));
      assert.equal(readFileSync(own, "utf8"), "# My own feature command\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
