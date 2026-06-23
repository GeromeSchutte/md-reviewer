/**
 * Spawns a headless Claude Code agent for a session opened with no agent
 * attached (the user-initiated path). Fully wired in task #6 with the Agent SDK
 * (`@anthropic-ai/claude-agent-sdk` `query()`), seeded with the stored review
 * history for the abspath and instructed to run the CLI wait-loop.
 *
 * For now this is a no-op stub so the broker runs end-to-end on the
 * agent-initiated and protocol-round-trip paths; the user-initiated spawn lights
 * up once the CLI (task #5) and SDK wiring (task #6) land.
 */
export interface SpawnInfo {
  sid: string;
  abspath: string;
  title: string;
}

export type Spawner = (info: SpawnInfo) => void;

export function makeSpawner(): Spawner {
  return (info: SpawnInfo) => {
    console.log(`[spawner] session ${info.sid} opened for ${info.abspath} with no agent (spawn TODO: task #6)`);
  };
}
