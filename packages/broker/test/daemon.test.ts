import { describe, it, expect } from "bun:test";
import { renderPlist, brokerEntryPath, bunPath } from "../src/daemon";

describe("LaunchAgent plist", () => {
  it("renders a valid always-on plist pointing at the broker entry", () => {
    const plist = renderPlist();
    expect(plist).toContain("<key>Label</key><string>ai.plan-review.broker</string>");
    // RunAtLoad + KeepAlive = always-on daemon
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    // ProgramArguments: bun + the broker entry point
    expect(plist).toContain(bunPath());
    expect(plist).toContain(brokerEntryPath());
    expect(brokerEntryPath()).toMatch(/packages\/broker\/src\/index\.ts$/);
  });
});
