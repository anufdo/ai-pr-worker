#!/usr/bin/env node

const prompt = process.argv.at(-1) ?? "";

process.stdout.write(`fake-ai stdout\n`);
process.stdout.write(`argv=${JSON.stringify(process.argv.slice(2))}\n`);
process.stdout.write(`promptLength=${prompt.length}\n`);
process.stdout.write(`promptIsSingleArg=${String(process.argv.slice(2).length === 4)}\n`);
process.stdout.write(`promptStartsWithReviewInstruction=${String(prompt.startsWith("You are a senior software engineer"))}\n`);
process.stderr.write("fake-ai stderr\n");
