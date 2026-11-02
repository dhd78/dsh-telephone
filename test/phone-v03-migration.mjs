import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "phone-v03-migrate-"));
process.env.DSH_HOME = home;
mkdirSync(join(home, "telephone"), { recursive: true });
writeFileSync(join(home, "telephone", "state.json"), JSON.stringify({
  version: 1,
  roster: { a: { alias: "A", enabled: true }, b: { alias: "B", enabled: true } },
  links: [{ a: "a", b: "b", max: 6 }],
  quotas: { a: 2 },
  unlimited: [],
  settings: { allowColdResume: true, defaultDelivery: "queue" },
  lines: [],
}), "utf8");

const bus = {
  async rows() { return [
    { sessionId: "a", title: "A", targetable: true, agentAvailable: true },
    { sessionId: "b", title: "B", targetable: true, agentAvailable: true },
  ]; },
  async resolveTarget(ref) { return { sessionId: ref }; },
  async send() { return { threadId: "t" }; },
};
const { createTelephone } = await import("../lib/telephone.js");
const phone = createTelephone({ ctx: {}, bus, config: {}, logger: {} });
try {
  const state = await phone.snapshot();
  const a = state.sessions.find((row) => row.sessionId === "a");
  assert.ok(a.mailboxId?.startsWith("mbx_"));
  assert.equal(state.settings.maxCallsPerHour, 5);
  await phone.save();
  const saved = JSON.parse(readFileSync(join(home, "telephone", "state.json"), "utf8"));
  assert.equal(saved.version, 2);
  assert.ok(saved.mailboxes[a.mailboxId]);
  console.log("phone v0.3 migration OK");
} finally {
  await phone.save();
  rmSync(home, { recursive: true, force: true });
}
