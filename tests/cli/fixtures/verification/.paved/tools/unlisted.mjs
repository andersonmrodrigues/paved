#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const marker = join(process.cwd(), ".paved/generated/evidence/unlisted-called.txt");
mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, "unlisted script ran\n");
