import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TerminalRun } from "../shared/terminal.js";
export interface TerminalBinding extends TerminalRun {
  dataDir: string;
  url: string;
  target: string;
  leaseToken: string;
  reportingToken: string;
  root: string;
  executable: string;
  configDir: string;
  packetPath: string;
}
export function readBinding(path: string): TerminalBinding {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function writeBinding(path: string, binding: TerminalBinding) {
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(binding), { mode: 0o600 });
  renameSync(temp, path);
}
