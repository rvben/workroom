import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
// Include standard user install locations without changing the user's shell configuration.
export function resolveCommand(command: string) {
  if (command.includes("/") || command.includes("\\")) return command;
  const dirs = [
    ...(process.env.PATH || "").split(delimiter),
    join(homedir(), ".local/bin"),
    join(homedir(), ".cargo/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs.filter(Boolean)) {
    const file = join(dir, command);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return command;
}
export type ToolRunner = (
  command: string,
  args: string[],
  timeout?: number,
  onSpawn?: (pid: number) => void,
) => Promise<string>;
export const toolRun: ToolRunner = (command, args, timeout = 10000, onSpawn) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      resolveCommand(command),
      args,
      {
        timeout,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
          CI: "1",
          HOMEBREW_NO_AUTO_UPDATE: "1",
          HOMEBREW_NO_ENV_HINTS: "1",
        },
      },
      (error, stdout) => {
        if (error) {
          const e = new Error(
            error.killed
              ? "Command timed out."
              : error.code === "ENOENT"
                ? "Command not found."
                : `Command failed (exit ${error.code}).`,
          ) as Error & { code?: string | number };
          e.code = error.code ?? undefined;
          reject(e);
        } else resolve(stdout);
      },
    );
    if (child.pid) onSpawn?.(child.pid);
    child.stdin?.end();
  });
