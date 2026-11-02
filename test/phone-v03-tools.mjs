import assert from "node:assert/strict";
import { registerPhoneTools } from "../lib/phone-tools.js";

const tools = new Map();
registerPhoneTools({ tools: { register(tool) { tools.set(tool.name, tool); } } }, {
  aliasOf: () => "A",
  async listFor() {
    return {
      self: "a",
      selfMailbox: { mailboxId: "mbx_a_1234", mailboxUnread: 1, dnd: false },
      quota: 1,
      unlimited: false,
      defaultDelivery: "queue",
      peers: [{ sessionId: "b", alias: "B", enabled: true, quota: 1, maxRounds: 6, count: 0, remainingMs: 1000, mailboxId: "mbx_b_1234", mailboxUnread: 0, dnd: false }],
      mailPeers: [{ sessionId: "c", alias: "C", enabled: true, hasLine: false, mailboxId: "mbx_c_1234", mailboxUnread: 2, dnd: true }],
      lines: [],
    };
  },
  async call() {
    return {
      ok: true, delivered: true, target: "b", targetTitle: "B", lineId: "line-1", count: 1, max: 6,
      quotaLeft: 0, unlimited: false, delivery: "queue", priority: "normal", callId: "call-1",
      state: "delivered", suppressed: false, deduped: false, closed: false, remainingMs: 1000,
    };
  },
  async statusFor() {
    return {
      self: "a", quota: 1, unlimited: false, defaultDelivery: "queue",
      peers: [], lines: [],
      calls: [{ callId: "call-1", from: "a", to: "b", lineId: "line-1", delivery: "queue", priority: "normal", state: "delivered", createdAt: 1, updatedAt: 2 }],
    };
  },
  async hangupLine() { return { ok: true, lineId: "line-1", reason: "hangup" }; },
  async mailboxListFor() {
    return {
      self: "a", alias: "A", mailboxId: "mbx_a_1234", unread: 1,
      letters: [{ letterId: "ltr_1", mailboxId: "mbx_a_1234", from: "b", to: "a", subject: "S", preview: "P", priority: "normal", state: "unread", createdAt: 1, expiresAt: 0 }],
    };
  },
  async mailboxRead() {
    return { ok: true, letterId: "ltr_1", mailboxId: "mbx_a_1234", subject: "S", from: "b", createdAt: 1, state: "read", body: "B" };
  },
  async mailboxSend() {
    return {
      ok: true, target: "c", targetTitle: "C", mailboxId: "mbx_c_1234", letterId: "ltr_2",
      from: "a", to: "c", subject: "S", preview: "P", priority: "normal", state: "unread", createdAt: 1, expiresAt: 0, deduped: false,
    };
  },
});

const exec = { agent: { id: "a" }, signal: undefined };
for (const [name, args] of [
  ["phone_list", {}],
  ["phone_call", { to: "b", note: "看信" }],
  ["phone_status", {}],
  ["phone_hangup", {}],
  ["phone_mailbox_list", {}],
  ["phone_mailbox_read", { letterId: "ltr_1" }],
  ["phone_mailbox_send", { to: "c", subject: "S", body: "B" }],
]) {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  const value = await tool.execute(args, exec);
  assert.ok(value && typeof value === "object", `${name} must return an object`);
}
console.log("phone v0.3 tools OK");
