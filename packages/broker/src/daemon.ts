import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import {
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  logErrPath,
  logOutPath,
  dataDir,
} from "./paths";

/** Absolute path to this broker's entry point (index.ts), resolved from this file. */
export function brokerEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.ts");
}

/** The Bun executable currently running. */
export function bunPath(): string {
  return process.execPath;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(): string {
  const bun = bunPath();
  const entry = brokerEntryPath();
  const path = `${dirname(bun)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bun)}</string>
    <string>${escapeXml(entry)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logOutPath())}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logErrPath())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
  </dict>
</dict>
</plist>
`;
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}
function serviceTarget(): string {
  return `gui/${uid()}/${LAUNCH_AGENT_LABEL}`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["launchctl", ...args]);
  const out = `${res.stdout?.toString() ?? ""}${res.stderr?.toString() ?? ""}`.trim();
  return { ok: res.exitCode === 0, out };
}

/** Write the LaunchAgent plist and load it (idempotent). */
export function installDaemon(): { plistPath: string } {
  const plistPath = launchAgentPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(plistPath, renderPlist());
  // Reload cleanly if already bootstrapped.
  launchctl(["bootout", serviceTarget()]);
  launchctl(["bootstrap", `gui/${uid()}`, plistPath]);
  launchctl(["enable", serviceTarget()]);
  launchctl(["kickstart", serviceTarget()]);
  return { plistPath };
}

export function uninstallDaemon(): void {
  launchctl(["bootout", serviceTarget()]);
  const plistPath = launchAgentPlistPath();
  if (existsSync(plistPath)) rmSync(plistPath, { force: true });
}

/** Force a restart (after a code change). */
export function restartDaemon(): { ok: boolean; out: string } {
  return launchctl(["kickstart", "-k", serviceTarget()]);
}

export function daemonInstalled(): boolean {
  return existsSync(launchAgentPlistPath());
}
