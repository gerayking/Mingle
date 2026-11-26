import { constants } from "node:fs";
import { glob, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sshTarget } from "./ssh.ts";

export interface SshConfigHosts {
  hosts: string[];
  incomplete: boolean;
}

// Discovery only: never run ssh -G (Match exec can run commands), and never
// resolve HostName, credentials or conditional configuration ourselves.
export async function readSshConfig(userHome = homedir()): Promise<SshConfigHosts> {
  const result: SshConfigHosts = { hosts: [], incomplete: false };
  const visited = new Set<string>();
  const active = new Set<string>();
  const aliases = new Set<string>();
  const sshDir = join(userHome, ".ssh");
  let remaining = 2 * 1024 * 1024;
  let files = 0;

  async function read(path: string, depth: number): Promise<void> {
    if (depth > 32 || files >= 256 || remaining <= 0) {
      result.incomplete = true;
      return;
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.incomplete = true;
      return;
    }
    if (active.has(canonical)) result.incomplete = true;
    if (visited.has(canonical)) return;
    visited.add(canonical);
    files++;
    let content: string;
    try {
      // Nonblocking open plus fstat avoids hanging on a FIFO in an Include glob.
      const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        const limit = Math.min(remaining, 1024 * 1024);
        if (!stat.isFile() || stat.size > limit) {
          result.incomplete = true;
          return;
        }
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        remaining -= size;
        if (size > limit) {
          result.incomplete = true;
          return;
        }
        content = buffer.toString("utf8", 0, size);
      } finally {
        await file.close();
      }
    } catch {
      result.incomplete = true;
      return;
    }
    active.add(canonical);
    for (const line of content.split(/\r?\n/)) {
      const directive = /^\s*(Host|Include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
      if (!directive) continue;
      const args = words(directive[2] ?? "");
      if (!args) {
        result.incomplete = true;
        continue;
      }
      if (directive[1]?.toLowerCase() === "host") {
        for (const alias of args) {
          if (/[*!?]/.test(alias)) continue;
          try {
            sshTarget(alias);
          } catch {
            result.incomplete = true;
            continue;
          }
          const key = alias.toLowerCase();
          if (aliases.has(key)) continue;
          if (aliases.size >= 4096) {
            result.incomplete = true;
            break;
          }
          aliases.add(key);
          result.hosts.push(alias);
        }
      } else {
        for (let pattern of args) {
          // Dynamic paths need a target-specific SSH evaluation. Leave that to ssh.
          if (pattern.includes("%") || pattern.includes("${") || /^~[^/]/.test(pattern)) {
            result.incomplete = true;
            continue;
          }
          if (pattern.startsWith("~/")) pattern = join(userHome, pattern.slice(2));
          if (!isAbsolute(pattern)) pattern = resolve(sshDir, pattern);
          try {
            const matches: string[] = [];
            for await (const match of glob(pattern)) {
              if (matches.length + files >= 256) {
                result.incomplete = true;
                break;
              }
              matches.push(match);
            }
            for (const match of matches.sort()) await read(match, depth + 1);
          } catch {
            result.incomplete = true;
          }
        }
      }
    }
    active.delete(canonical);
  }

  await read(join(sshDir, "config"), 0);
  return result;
}

// Tokenize only Host/Include arguments. Quotes and escaped separators allow
// Include paths with spaces; comments outside quotes are ignored.
function words(line: string): string[] | null {
  const result: string[] = [];
  let word = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      break;
    } else if (/\s/.test(char)) {
      if (word) result.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (quote) return null;
  if (word) result.push(word);
  return result;
}
