#!/usr/bin/env node

for await (const _chunk of process.stdin) {
  // Drain stdin until EOF. runFile should provide EOF immediately.
}

process.stdout.write("stdin closed\n");
