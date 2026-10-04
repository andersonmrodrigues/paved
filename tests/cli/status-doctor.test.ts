import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LEGACY_BLOCK = readFileSync(join(core, "core/templates/AGENTS.md"), "utf8").replace(/Change code through Paved:[\s\S]*?available\.\n/, "Change code through the Paved commands (`/paved:feature`, `/paved:fix`,\n`/paved:refactor`, `/paved:verify`; `/paved:status` shows what is available) so project\nrules and verification apply.\n");

async function withConsumer(setup: (project: string) => void, check: (project: string) => Promise<void>) {
  const project = mkdtempSync(join(tmpdir(), "paved-status-"));
  try {
    writeFileSync(join(project, "README.md"), "# Consumer\n");
    initializeConsumer(core, project, "consumer");
    setup(project);
    await check(project);
  } finally { rmSync(project, { recursive: true, force: true }); }
}

const run = (project: string, ...argv: string[]) => dispatchCli({ argv: [...argv, "--project", project, "--json"], cwd: project, executablePath: join(core, "cli/index.ts") });
const listing = (project: string) => JSON.stringify(readdirSync(project, { recursive: true }).sort());

describe("status absorbs doctor", () => {
  for (const [name, setup] of [
    ["fresh", () => undefined],
    ["without a lock", (project: string) => rmSync(join(project, ".paved/paved.lock"))],
  ] as const) {
    it(`reports what doctor reports (${name}), read-only`, async () => {
      await withConsumer(setup, async (project) => {
        const before = listing(project);
        const status = await run(project, "status");
        const doctor = await run(project, "doctor");
        assert.equal(listing(project), before, "status or doctor wrote files without --answer");
        assert.deepEqual(status.diagnostics.map((item) => item.code), doctor.diagnostics.map((item) => item.code));
        assert.deepEqual((status.decisions ?? []).map((item) => item.id), (doctor.decisions ?? []).map((item) => item.id));
        assert.deepEqual((status.data as { actionableFindings: unknown }).actionableFindings, (doctor.data as { actionableFindings: unknown }).actionableFindings);
        if (name === "fresh") assert.ok(!status.diagnostics.some((item) => item.code === "PAVED_AGENTS_BLOCK_OUTDATED"), JSON.stringify(status.diagnostics));
      });
    });
  }

  it("warns when the managed AGENTS.md block is outdated", async () => {
    await withConsumer((project) => writeFileSync(join(project, "AGENTS.md"), `# Team notes\n\n${LEGACY_BLOCK}`), async (project) => {
      const status = await run(project, "status");
      assert.ok(status.diagnostics.some((item) => item.code === "PAVED_AGENTS_BLOCK_OUTDATED"), JSON.stringify(status.diagnostics));
    });
  });
});
