import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs -p --model opus "{{PROMPT}}"';
process.env.MAX_JOB_MINUTES = "1";
process.env.AUTO_MERGE = "false";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(repoRoot);

const { commandFromTemplate } = await import("../dist/ai/providers/custom.js");
const { runAi } = await import("../dist/ai/aiRunner.js");
const { runFile } = await import("../dist/utils/exec.js");

test('parses AI_COMMAND=claude -p --model opus "{{PROMPT}}" as executable plus args', () => {
  const prompt = 'Fix this PR.\nDo not split this prompt; keep "quotes" intact.';
  const { command, args } = commandFromTemplate('claude -p --model opus "{{PROMPT}}"', { PROMPT: prompt });

  assert.equal(command, "claude");
  assert.deepEqual(args, ["-p", "--model", "opus", prompt]);
});

test("runAi logs execution and returns combined stdout/stderr from the AI command", async () => {
  const logs = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const output = await runAi(
      {
        repo: "local/test-repo",
        repoCloneUrl: "https://github.com/local/test-repo.git",
        defaultBranch: "main",
        prNumber: 7,
        title: "Exercise AI command",
        body: "Unit test body.",
        branch: "feature/ai-command-test",
        headSha: "0".repeat(40),
        url: "https://github.com/local/test-repo/pull/7",
      },
      repoRoot,
    );

    assert.match(logs.join("\n"), /INFO Running executable/);
    assert.match(logs.join("\n"), /INFO Executable completed/);
    assert.match(logs.join("\n"), /"command":"node"/);
    assert.match(logs.join("\n"), /"args":\["tests\/fixtures\/fake-ai-cli\.mjs","-p","--model","opus",/);
    assert.match(logs.join("\n"), /"stdoutBytes":[1-9]\d*/);
    assert.match(logs.join("\n"), /"stderrBytes":[1-9]\d*/);

    assert.match(output, /^fake-ai stdout/);
    assert.match(output, /argv=\["-p","--model","opus","[\s\S]+"\]/);
    assert.match(output, /promptIsSingleArg=true/);
    assert.match(output, /promptStartsWithReviewInstruction=true/);
    assert.match(output, /fake-ai stderr$/);
  } finally {
    console.log = originalConsoleLog;
  }
});

test("runFile closes child stdin so noninteractive AI CLIs do not hang", async () => {
  const { stdout, stderr } = await runFile("node", ["tests/fixtures/stdin-wait-ai-cli.mjs"], repoRoot);

  assert.equal(stdout, "stdin closed\n");
  assert.equal(stderr, "");
});
