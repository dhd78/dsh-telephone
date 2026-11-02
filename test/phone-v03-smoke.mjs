import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "phone-v03-"));
process.env.DSH_HOME = home;

const rows = [
  { sessionId: "a", title: "A", targetable: true, agentAvailable: true },
  { sessionId: "b", title: "B", targetable: true, agentAvailable: true },
  { sessionId: "c", title: "C", targetable: true, agentAvailable: true },
];
let sends = 0;
let injected = 0;
const bus = {
  async rows() { return rows; },
  async resolveTarget(ref) {
    const row = rows.find((item) => item.sessionId === ref || item.title === ref);
    if (!row) throw new Error("no target");
    return row;
  },
  async send() { sends += 1; return { threadId: `thread-${sends}` }; },
};
const agents = { get() { return { inject() { injected += 1; } }; } };
const ctx = { agents, get(name) { return name === "agents" ? agents : undefined; } };
const { createTelephone } = await import("../lib/telephone.js");
const phone = createTelephone({ ctx, bus, config: {}, logger: { info() {}, warn() {}, debug() {} } });

try {
  await phone.saveRoster([
    { sessionId: "a", alias: "A", enabled: true },
    { sessionId: "b", alias: "B", enabled: true },
    { sessionId: "c", alias: "C", enabled: true },
  ]);
  await phone.saveLinks([{ a: "a", b: "b", max: 6 }]);
  await phone.setQuota("a", 2);

  // Mailbox: no telephone line required, and no session wake.
  const sent = await phone.mailboxSend({
    sender: { id: "a" },
    to: "C",
    subject: "测试信",
    body: "正文只在 C 的邮箱里。",
    priority: "low",
    dedupeKey: "mail-1",
  });
  assert.equal(sent.mailboxId.startsWith("mbx_"), true);
  assert.equal(sends, 0);
  assert.equal(injected, 0);

  const duplicate = await phone.mailboxSend({
    sender: { id: "a" },
    to: "C",
    subject: "测试信",
    body: "重复正文",
    dedupeKey: "mail-1",
  });
  assert.equal(duplicate.letterId, sent.letterId);
  assert.equal(duplicate.deduped, true);

  const cList = await phone.mailboxListFor({ id: "c" });
  assert.equal(cList.unread, 1);
  const cRead = await phone.mailboxRead({ id: "c" }, sent.letterId);
  assert.equal(cRead.body, "正文只在 C 的邮箱里。");
  assert.equal((await phone.mailboxListFor({ id: "c" })).unread, 0);
  assert.equal(sends, 0);

  // Explicit quiet / low priority: mailbox metadata only, no ring, no line/quota.
  const quiet = await phone.call({ sender: { id: "a" }, to: "B", note: "静默测试", priority: "low" });
  assert.equal(quiet.suppressed, true);
  assert.equal(quiet.delivery, "quiet");
  assert.equal(sends, 0);
  assert.equal(phone.quotaOf("a"), 2);

  // Per-target DND suppresses normal calls.
  await phone.setDnd("b", true);
  const dnd = await phone.call({ sender: { id: "a" }, to: "B", note: "DND 测试", priority: "normal" });
  assert.equal(dnd.suppressed, true);
  assert.equal(dnd.reason, "dnd");
  assert.equal(sends, 0);
  await phone.setDnd("b", false);

  // DedupeKey prevents a second wake with the same in-flight key.
  const first = await phone.call({ sender: { id: "a" }, to: "B", note: "一次", dedupeKey: "call-1" });
  assert.equal(first.deduped, false);
  assert.equal(sends, 1);
  const second = await phone.call({ sender: { id: "a" }, to: "B", note: "一次", dedupeKey: "call-1" });
  assert.equal(second.deduped, true);
  assert.equal(sends, 1);
  assert.equal(second.callId, first.callId);

  await phone.setMaxCallsPerHour(null);
  assert.equal((await phone.snapshot()).settings.maxCallsPerHour, null);

  // Bad mailbox path is rejected; root path is returned for the owner route.
  assert.throws(() => phone.mailboxPathFor("../../outside"), (error) => error.code === "mailbox-not-found" || error.code === "bad-mailbox");
  assert.ok(phone.mailboxPathFor().endsWith("mailboxes"));

  await phone.save();
  console.log("phone v0.3 smoke OK");
} finally {
  await phone.save();
  rmSync(home, { recursive: true, force: true });
}
