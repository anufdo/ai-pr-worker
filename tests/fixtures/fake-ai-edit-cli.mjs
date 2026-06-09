#!/usr/bin/env node
/**
 * Fake AI CLI that actually edits a file in its working directory, so the
 * worker-level e2e harness can assert on the resulting commit. The file it
 * writes is controlled by FAKE_AI_EDIT_FILE (default: ai-change.txt), relative
 * to the current working directory (the checkout the worker runs the CLI in).
 *
 * Set FAKE_AI_EDIT_FILE to a protected path (e.g. ".env") to exercise the
 * blocked-file rejection path.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const target = process.env.FAKE_AI_EDIT_FILE || "ai-change.txt";
const file = path.resolve(process.cwd(), target);
mkdirSync(path.dirname(file), { recursive: true });
appendFileSync(file, `edited by fake-ai-edit-cli at run ${process.argv.slice(2).length} args\n`);

process.stdout.write("fake-ai-edit stdout: applied the requested change\n");
process.stdout.write(`edited file: ${target}\n`);
process.stderr.write("fake-ai-edit stderr\n");
