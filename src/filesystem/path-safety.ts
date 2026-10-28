import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export async function createPathValidator(directories: string[]) {
  const lexical = directories.map(directory => path.resolve(directory));
  const canonical = await Promise.all(lexical.map(directory => fs.realpath(directory)));
  const allowed = (candidate: string) => canonical.some(directory => contains(directory, candidate));

  return async function validatePath(requestedPath: string): Promise<string> {
    const absolute = path.resolve(requestedPath);
    if (![...lexical, ...canonical].some(directory => contains(directory, absolute))) {
      throw new Error("Access denied - path outside allowed directories: " + absolute);
    }
    try {
      const real = await fs.realpath(absolute);
      if (!allowed(real)) throw new Error("Access denied - symlink target outside allowed directories");
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // A dangling leaf is an existing link, not permission to create a new target.
    try {
      await fs.lstat(absolute);
      throw new Error("Access denied - unresolved existing path: " + absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await fs.realpath(path.dirname(absolute));
    if (!allowed(parent)) throw new Error("Access denied - parent directory outside allowed directories");
    return path.join(parent, path.basename(absolute));
  };
}

export async function readFileSafely(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const real = await fs.realpath(filePath);
    if (path.relative(filePath, real) !== "") throw new Error("Access denied - path changed after validation");
    const opened = await handle.stat();
    const current = await fs.stat(real);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("Access denied - file changed after validation");
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

// Atomic replacement prevents leaf-link swaps and preserves regular-file owner/mode.
export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  let previous;
  try {
    previous = await fs.lstat(filePath);
    if (!previous.isFile()) throw new Error("Access denied - write target is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(filePath), ".mcp-write-" + randomUUID());
  let handle;
  let created = false;
  try {
    handle = await fs.open(temporary, "wx", previous ? previous.mode & 0o777 : 0o666);
    created = true;
    if (previous) {
      await handle.chmod(previous.mode & 0o777);
      const owned = await handle.stat();
      if (owned.uid !== previous.uid || owned.gid !== previous.gid) await handle.chown(previous.uid, previous.gid);
    }
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
  } finally {
    await handle?.close();
    if (created) {
      try { await fs.unlink(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
