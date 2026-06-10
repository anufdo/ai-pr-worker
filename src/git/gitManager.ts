import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { runFile } from "../utils/exec.js";

function repoPath(repo: string): string {
  return path.join(config.workdir, repo.replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

function authenticatedUrl(cloneUrl: string): string {
  const url = new URL(cloneUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("Only HTTPS github.com clone URLs are supported");
  url.username = "x-access-token";
  url.password = config.githubToken;
  return url.toString();
}

export async function prepareRepo(repo: string, cloneUrl: string, branch: string): Promise<string> {
  const directory = repoPath(repo);
  await mkdir(config.workdir, { recursive: true });
  let exists = true;
  try {
    await stat(directory);
  } catch {
    exists = false;
  }
  if (exists) {
    await runFile("git", ["-C", directory, "rev-parse", "--git-dir"]);
    await runFile("git", ["-C", directory, "remote", "set-url", "origin", authenticatedUrl(cloneUrl)]);
    await runFile("git", ["-C", directory, "fetch", "--prune", "origin"]);
  } else {
    await runFile("git", ["clone", authenticatedUrl(cloneUrl), directory]);
  }
  await checkoutBranch(directory, branch);
  return directory;
}

// Pin the working tree to origin/<branch>. The clone is persistent and reused
// across jobs, so it can carry leftover state from a previous run. `-f` discards
// local changes and untracked files that are in the way, so that leftover state
// can't abort the checkout ("untracked working tree files would be overwritten");
// reset --hard and clean then pin the tree to the remote exactly.
export async function checkoutBranch(directory: string, branch: string): Promise<void> {
  await runFile("git", ["-C", directory, "checkout", "-f", "-B", branch, `origin/${branch}`]);
  await runFile("git", ["-C", directory, "reset", "--hard", `origin/${branch}`]);
  await runFile("git", ["-C", directory, "clean", "-fd"]);
}

export async function changedFiles(directory: string): Promise<string[]> {
  const { stdout } = await runFile("git", ["-C", directory, "status", "--porcelain", "-u"]);
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
}

// Paths git reports as deleted in the working tree (staged or unstaged).
// `git status --porcelain` prefixes each line with a two-char XY status; a "D"
// in either column means the file was removed.
export async function deletedPaths(directory: string): Promise<string[]> {
  const { stdout } = await runFile("git", ["-C", directory, "status", "--porcelain"]);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => line[0] === "D" || line[1] === "D")
    .map((line) => line.slice(3));
}

export async function commitAndPush(directory: string, branch: string, message = "AI: handle task"): Promise<string> {
  await runFile("git", ["-C", directory, "add", "--all"]);
  await runFile("git", ["-C", directory, "commit", "-m", message]);
  const { stdout } = await runFile("git", ["-C", directory, "rev-parse", "HEAD"]);
  if (config.autoPush) await runFile("git", ["-C", directory, "push", "origin", `HEAD:${branch}`]);
  return stdout.trim();
}
