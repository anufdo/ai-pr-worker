// Safety guards shared by the webhook gate (defense at the door) and the job
// processor (defense in depth, immediately before any commit).

// Paths the worker refuses to commit even if the AI changed them: env files,
// the git internals, deploy/deployment dirs, and anything that looks like
// credentials or secrets.
export const blockedFiles =
  /(^|\/)(\.env($|\.)|\.git\/|deploy($|\/)|deployment($|\/)|credentials?($|\.)|secrets?($|\.))/i;

// A branch the worker must never push to. Mirrors webhook.ts and is re-checked
// in processPrJob before committing.
export function isProtectedBranch(branch: string, defaultBranch: string): boolean {
  return [defaultBranch, "main", "master"].includes(branch);
}

// Of the given changed files, return the ones the worker refuses to commit.
// Backslashes are normalized so Windows-style git output matches the regex.
export function blockedPaths(files: readonly string[]): string[] {
  return files.filter((file) => blockedFiles.test(file.replaceAll("\\", "/")));
}

// True when a changed path looks like a test file per the configured regex.
// Backslashes are normalized so Windows-style git output matches.
export function isTestPath(file: string, testFileRegex: RegExp): boolean {
  return testFileRegex.test(file.replaceAll("\\", "/"));
}

// Of the given changed files, return the ones that are NOT test files. Used to
// keep the `add-tests` action from touching production code.
export function nonTestPaths(files: readonly string[], testFileRegex: RegExp): string[] {
  return files.filter((file) => !isTestPath(file, testFileRegex));
}
