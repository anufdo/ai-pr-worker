#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";

const message = process.argv.at(-1) ?? "";
writeFileSync(path.join(process.cwd(), "hermes-change.txt"), `hermes applied\n${message.includes("Claude read-only plan:")}\n`);
console.log("hermes applied the plan");
