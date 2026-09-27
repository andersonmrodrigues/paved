#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? "" : args[index + 1] ?? "";
};
const mode = valueFor("--mode");
const secret = valueFor("--secret");
const literal = valueFor("--literal");
const marker = join(process.cwd(), ".paved/generated/evidence/marker-called.txt");
mkdirSync(dirname(marker), { recursive: true });
const markerArgs = args.map((arg, index) => args[index - 1] === "--secret" ? "[REDACTED]" : arg);
writeFileSync(marker, `mode:${mode}\nsecret:${secret ? "[REDACTED]" : ""}\nliteral:${literal}\nargv:${JSON.stringify(markerArgs)}\n`);
console.log(`marker mode=${mode} secret=${secret} literal=${literal}`);
console.error(`stderr secret=${secret}`);

if (mode === "timeout") {
  setTimeout(() => {}, 10_000);
} else if (mode === "fail") {
  process.exit(3);
}
