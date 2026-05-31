import { github, splitRepo } from "./githubClient.js";

export async function commentOnPr(repo: string, prNumber: number, body: string): Promise<void> {
  const { owner, repo: name } = splitRepo(repo);
  await github.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
}
