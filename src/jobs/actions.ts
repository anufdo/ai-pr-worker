import { config } from "../config.js";

// The set of label-driven actions the worker can perform. Each maps to a prompt
// and a behavior with an explicit risk level (see docs/IMPROVEMENT_PLAN.md).
export type PrAction = "review" | "test" | "fix-review" | "full-fix" | "e2e";

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
  { label: "test-it", action: "test" },
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
  e2e: "pr-review.md",
};

export function promptFileForAction(action: PrAction): string {
  return PROMPT_FILES[action];
}

export function commitMessageForAction(action: PrAction, prNumber: number): string {
  return `AI (${action}) for PR #${prNumber}`;
}
