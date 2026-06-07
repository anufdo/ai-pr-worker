#!/usr/bin/env node
// Floods stdout so runFile's output-cap path can fire. Writes in chunks until
// killed; the worker should SIGTERM it once the cap is exceeded.
const chunk = "x".repeat(64 * 1024);
const timer = setInterval(() => {
  process.stdout.write(chunk);
}, 1);
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(143);
});
