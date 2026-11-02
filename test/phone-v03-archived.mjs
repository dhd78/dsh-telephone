import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "phone-v03-archived-"));
process.env.DSH_HOME = home;
const rows = [
  { sessionId: "a", title: "A", targetable: true, agentAvailable: true },
  { sessionId: "b", title: "B", targetable: true, agentAvailable: true },
  { sessionId: "c", title: "C", targetable: true, agentAvailable: true },
];
const bus = {
  async rows() { return rows; },
  async resolveTarget(ref) { return rows.find((row) => row.sessionId === ref || row.title === ref); },
  async send() { return { threadId: "t" }; },
};
const ctx = { workspaceRegistry: { archivedSessionIds: ["b"] }, get(name) { return name === "workspaceRegistry" ? this.workspaceRegistry : undefined; } };
const { createTelephone } = await import("../lib/telephone.js");
const phone = createTelephone({ ctx, bus, config: {}, logger: {} });
try {
  await phone.saveRoster([
    { sessionId: "a", alias: "A", enabled: true },
    { sessionId: "c", alias: "C", enabled: true },
  ]);
  await phone.saveLinks([{ a: "a", b: "c", max: 6 }]);
  const state = await phone.snapshot();
  assert.deepEqual(state.sessions.map((row) => row.sessionId).sort(), ["a", "c"]);
  const list = await phone.listFor({ id: "a" });
  assert.deepEqual(list.mailPeers.map((row) => row.sessionId), ["c"]);
  assert.equal(list.peers.length, 1);
  await assert.rejects(() => phone.resolveTarget("B", { id: "a" }), (error) => error.code === "archived");
  console.log("phone v0.3 archived OK");
} finally {
  await phone.save();
  rmSync(home, { recursive: true, force: true });
}
