import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelephone } from "../lib/telephone.js";

const home = mkdtempSync(join(tmpdir(), "phone-v02-"));
process.env.DSH_HOME = home;

let lastSend = null;
const bus = {
  async rows() {
    return [
      { sessionId: "a", targetable: true, agentAvailable: true, title: "A" },
      { sessionId: "b", targetable: true, agentAvailable: true, title: "B" },
    ];
  },
  async send(input) {
    lastSend = input;
    return { threadId: "thread-1", delivered: true };
  },
};
const phone = createTelephone({
  ctx: {},
  bus,
  config: {},
  logger: { info() {}, warn() {}, debug() {} },
});
phone.roster = { a: { alias: "A", enabled: true }, b: { alias: "B", enabled: true } };
phone.links = [{ a: "a", b: "b", max: 6 }];
phone.quotas = { a: 2 };

try {
  const first = await phone.call({ sender: { id: "a" }, to: "b", note: "看信" });
  assert.equal(lastSend.mode, "queue");
  assert.equal(first.delivery, "queue");
  assert.equal(first.quotaLeft, 1);

  const second = await phone.call({ sender: { id: "a" }, to: "b", note: "回电", line: first.lineId, delivery: "steer" });
  assert.equal(lastSend.mode, "steer");
  assert.equal(second.delivery, "steer");

  await phone.hangupLine(first.lineId, { id: "a" });
  await phone.setQuota("a", 0, true);
  const unlimited = await phone.call({ sender: { id: "a" }, to: "b", note: "软无限" });
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.quotaLeft, 0);
  assert.equal(phone.unlimited.has("a"), true);

  await phone.setDefaultDelivery("steer");
  assert.equal((await phone.snapshot()).settings.defaultDelivery, "steer");
  console.log("phone v0.2 smoke OK");
} finally {
  await phone.save();
  rmSync(home, { recursive: true, force: true });
}
