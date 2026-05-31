import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

function lockPath(key: string): string {
  return path.join(config.workdir, "..", "locks", `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.lock`);
}

export async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const file = lockPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Job is already locked: ${key}`);
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await action();
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}
