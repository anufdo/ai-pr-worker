import { config } from "../config.js";

// The set of label-driven actions the worker can perform. Each maps to a prompt
// and a behavior with an explicit risk level (see docs/IMPROVEMENT_PLAN.md).
export type PrAction = "review" | "test" | "fix-review" | "full-fix" | "e2e" | "add-tests" | "pass-tests";

interface ActionLabel {
  label: string;
  action: PrAction;
}

// Listed in precedence order: highest automation first. When a PR carries more
// than one action label, the first match here wins, and that choice is named in
// the PR comment and the logs.
export const ACTION_LABELS: readonly ActionLabel[] = [
  { label: "need-this", action: "full-fix" },
  { label: "fix-review", action: "fix-review" },
  { label: "pass-tests", action: "pass-tests" },
  { label: "test-it", action: "test" },
  { label: "add-tests", action: "add-tests" },
  { label: "e2e-it", action: "e2e" },
  { label: "review-it", action: "review" },
];

// Read-only actions never commit or push; they only run the AI and report.
const READ_ONLY_ACTIONS: ReadonlySet<PrAction> = new Set(["review", "e2e"]);

export function isReadOnlyAction(action: PrAction): boolean {
  return READ_ONLY_ACTIONS.has(action);
}

// Resolve the action a PR should run from its labels, applying the precedence
// rule above. The configured trigger label (default `need-this`) always maps to
// the highest-automation `full-fix` action for backward compatibility.
export function resolveAction(labels: readonly string[]): PrAction | null {
  const present = new Set(labels);
  if (present.has(config.triggerLabel)) return "full-fix";
  for (const { label, action } of ACTION_LABELS) {
    if (present.has(label)) return action;
  }
  return null;
}

// Per-action prompt template under prompts/. `e2e` reuses the read-only review
// prompt; the new behavior for that action is that it runs the e2e check.
const PROMPT_FILES: Record<PrAction, string> = {
  review: "pr-review.md",
  test: "pr-test.md",
  "fix-review": "pr-fix-review.md",
  "full-fix": "pr-full-fix.md",
  "add-tests": "pr-add-tests.md",
  "pass-tests": "pr-pass-tests.md",
  e2e: "pr-review.md",
};

export function promptFileForAction(action: PrAction): string {
  return PROMPT_FILES[action];
}

export function commitMessageForAction(action: PrAction, prNumber: number): string {
  return `AI (${action}) for PR #${prNumber}`;
}

// Canonical, load-bearing constraints for an action. This is the single source
// of truth for what an action may change; it is appended to the direct prompt and
// injected into the Hermes planning and apply prompts so the rules hold on every
// path (Hermes on or off). Only the two pipeline actions add constraints; every
// other action returns "" to preserve its existing behavior.
export function actionConstraints(action: PrAction): string {
  switch (action) {
    case "add-tests":
      return [
        "HARD CONSTRAINTS for this task (add-tests):",
        "- You may ONLY add or edit test files and minimal test fixtures/helpers.",
        "- Do NOT modify any production (non-test) code, for any reason — not even to fix a bug you find.",
        "- Cover the changed behavior: happy path, edge cases, and realistic failure scenarios.",
        "- The new tests MAY fail against the current code — that is expected and acceptable here; a later `pass-tests` run will make them pass.",
        "- Do not weaken a test just to make it pass. List every test file you add or change.",
      ].join("\n");
    case "pass-tests":
      return [
        "HARD CONSTRAINTS for this task (pass-tests):",
        "- Make the existing committed tests pass by editing PRODUCTION code only.",
        "- Keep edits minimal: change only what is needed to make the tests pass; no unrelated changes or refactors.",
        "- Do NOT change test logic, assertions, or expected values.",
        "- You MAY edit a test ONLY for a mechanical rename: when a variable/function it references was renamed, or a call signature / new function call changed. Nothing else.",
        "- Do NOT delete, skip, or weaken any test.",
        "- If a test cannot pass without changing its logic, STOP and report it instead of editing the test.",
        "- List every test-file edit you made and why.",
      ].join("\n");
    default:
      return "";
  }
}
