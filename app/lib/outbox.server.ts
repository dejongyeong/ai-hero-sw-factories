import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Outbox ───
// Where outgoing email and Notifications land when no provider is configured
// (local dev, tests): one timestamped JSON file each, readable without sending
// anything.

/** Writes `payload` to `<directory>/<timestamp>-<name>.json`. */
export function writeToOutbox(
  directory: string,
  name: string,
  payload: unknown
): void {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${Date.now()}-${name}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
}
