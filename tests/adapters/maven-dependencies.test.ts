import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { planMavenDependencies } from "../../adapters/technology/java/maven-dependencies.ts";

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function project(poms: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paved-maven-deps-"));
  roots.push(root);
  for (const [scope, pom] of Object.entries(poms)) {
    mkdirSync(join(root, scope), { recursive: true });
    writeFileSync(join(root, scope, "pom.xml"), pom);
  }
  return root;
}

const pom = (artifact: string, dependency?: string) => `<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1.0</version></parent><artifactId>${artifact}</artifactId>${dependency ? `<dependencies><dependency><groupId>example</groupId><artifactId>${dependency}</artifactId><version>1.0</version></dependency></dependencies>` : ""}</project>`;

it("orders transitive local Maven dependencies and installs every consumed artifact", () => {
  const root = project({
    api: pom("api", "service"),
    service: pom("service", "library"),
    library: pom("library"),
  });
  const plan = planMavenDependencies(root, ["api", "service", "library"]);
  assert.deepEqual(plan.scopes, ["library", "service", "api"]);
  assert.deepEqual([...plan.installs].sort(), ["library", "service"]);
});

it("rejects a local Maven dependency cycle", () => {
  const root = project({ api: pom("api", "service"), service: pom("service", "api") });
  assert.throws(() => planMavenDependencies(root, ["api", "service"]), /dependency cycle/);
});
