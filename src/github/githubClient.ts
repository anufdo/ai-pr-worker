import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

export const github = new Octokit({ auth: config.githubToken });

export function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length) throw new Error(`Invalid GitHub repository name: ${repo}`);
  return { owner, repo: name };
}
