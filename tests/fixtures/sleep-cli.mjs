#!/usr/bin/env node
// Stays alive well past any test timeout so runFile's timeout path can fire.
// runFile sends SIGTERM; keep a handle so we don't exit before that.
const timer = setTimeout(() => process.exit(0), 60_000);
process.on("SIGTERM", () => {
  clearTimeout(timer);
  process.exit(143);
});
process.stdout.write("sleeping\n");
