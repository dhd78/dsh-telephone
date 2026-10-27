import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelephone } from '../lib/telephone.js';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-telephone-'));

const rows = [
  { sessionId: 'session-a', title: 'A', cwd: 'Z:/x', targetable: true, running: false, agentAvailable: true },
  { sessionId: 'session-b', title: 'B', cwd: 'Z:/x', targetable: true, running: false, agentAvailable: false },
  { sessionId: 'session-c', title: 'C', cwd: 'Z:/x', targetable: true, running: false, agentAvailable: false },
];

let nextThread = 0;
const sent = [];
const bus = {
  config: { deliveryTimeoutMs: 1000 },
  async rows() { return rows; },
  async resolveTarget(ref) {
    const row = rows.find((item) => item.sessionId === ref || item.title === ref);
    if (!row) throw new Error('no target');
    return row;
  },
  async send(input) {
    if (!input.message.includes('[电话]')) throw new Error('not a phone call');
    sent.push(input);
    nextThread += 1;
    return { threadId: `t-${nextThread}`, messageId: `m-${nextThread}` };
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const injected = [];
const agents = {
  get(sessionId) {
    if (sessionId !== 'session-a' && sessionId !== 'session-b') return undefined;
    return {
      inject(payload) {
        injected.push(payload);
      },
    };
  },
};
const ctx = {
  agents,
  get(name) { return name === 'agents' ? agents : undefined; },
};

const phone = createTelephone({ ctx, bus, config: {}, logger: {} });
await phone.saveRoster([
  { sessionId: 'session-a', alias: 'A', enabled: true },
  { sessionId: 'session-b', alias: 'B', enabled: true },
  { sessionId: 'session-c', alias: 'C', enabled: true },
]);
await phone.saveLinks([{ a: 'session-a', b: 'session-b', max: 2 }]);
await phone.setQuota('session-a', 1);

await phone.setAllowColdResume(false);
rows[1].agentAvailable = false;
let coldBlocked = false;
try {
  await phone.call({ to: 'B', note: '离线唤醒应被禁止', sender: { id: 'session-a' } });
} catch (error) {
  coldBlocked = error.code === 'cold-resume-disabled';
}
assert(coldBlocked, 'cold resume toggle must block offline targets');
rows[1].agentAvailable = true;
await phone.setAllowColdResume(true);

const first = await phone.call({ to: 'B', note: '我是 A，请看信箱。', sender: { id: 'session-a' } });
assert(first.count === 1 && first.max === 2, 'first call should be 1/2');
assert(first.quotaLeft === 0, 'first call consumes quota');

const second = await phone.call({ to: 'B', note: '我是 A，回电。', line: first.lineId, sender: { id: 'session-a' } });
assert(second.count === 2, 'second call should be 2');
assert(second.closed === true, 'line should close at max');

let quotaError = false;
try {
  await phone.call({ to: 'B', note: '第三次', sender: { id: 'session-a' } });
} catch (error) {
  quotaError = error.code === 'quota-empty';
}
assert(quotaError, 'no quota after max');

await phone.setQuota('session-a', 1);
const third = await phone.call({ to: 'B', note: '新专线', sender: { id: 'session-a' } });
assert(third.lineId !== first.lineId, 'new line should be created');
assert(third.count === 1, 'new line starts at 1');

let tooLong = false;
try {
  await phone.call({ to: 'B', note: 'x'.repeat(101), sender: { id: 'session-a' } });
} catch (error) {
  tooLong = error.code === 'note-too-long';
}
assert(tooLong, '101 chars must be rejected');

const hangup = await phone.hangupLine(third.lineId, { id: 'session-a' });
assert(hangup.ok === true, 'hangup should work');
assert(injected.length >= 2, 'closing a live line should emit quiet notices');
for (const payload of injected) {
  assert(typeof payload.id === 'string' && payload.id.length > 0, 'quiet notice needs an id');
  assert(payload.role === 'user', 'quiet notice needs role=user');
  assert(Array.isArray(payload.content) && payload.content[0]?.type === 'text', 'quiet notice needs text content');
  assert(payload.source?.kind === 'telephone', 'quiet notice needs a telephone source');
}

await phone.setQuota('session-a', 1);
const idle = await phone.call({ to: 'B', note: '超时测试', sender: { id: 'session-a' } });
const idleLine = phone.lines.find((line) => line.id === idle.lineId);
assert(idleLine !== undefined, 'idle line should exist');
idleLine.lastAt = Date.now() - 61 * 60 * 1000;
phone.expire();
assert(idleLine.status === 'closed' && idleLine.reason === 'idle', '61 minutes idle should close the line');

await new Promise((resolve) => setTimeout(resolve, 80));
const auditLines = readFileSync(join(process.env.DSH_HOME, 'telephone', 'audit.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const hangupAudit = auditLines.find((entry) => entry.action === 'line-closed' && entry.line === third.lineId);
assert(hangupAudit !== undefined, 'hangup should be audited');
assert(hangupAudit.closedBy === 'session-a', 'closedBy must be the session that hung up');
assert(hangupAudit.from === 'session-a' && hangupAudit.to === 'session-b', 'from/to keep line participants');
const idleAudit = auditLines.find((entry) => entry.action === 'line-closed' && entry.line === idle.lineId);
assert(idleAudit?.closedBy === 'system', 'idle expiry should record system as closer');

rows[2].agentAvailable = true;
await phone.saveLinks([{ a: 'session-a', b: 'session-c', max: 3 }]);
await phone.setQuota('session-a', 1);
const removeCall = await phone.call({ to: 'C', note: '移出电话簿测试', sender: { id: 'session-a' } });
const removeLine = phone.lines.find((line) => line.id === removeCall.lineId);
assert(removeLine?.status === 'active', 'line to C should be active before removal');
await phone.removeFromRoster('session-c');
assert(phone.roster['session-c'] === undefined, 'removed node must leave the phonebook');
assert(phone.links.every((link) => link.a !== 'session-c' && link.b !== 'session-c'), 'links to removed node must be deleted');
assert(phone.quotas['session-c'] === undefined, 'quota of removed node must be deleted');
assert(removeLine.status === 'closed' && removeLine.reason === 'unlink', 'active line to removed node must close');

await phone.saveLinks([{ a: 'session-a', b: 'session-b', max: 3 }]);
await phone.setQuota('session-a', 1);
const ownerCall = await phone.call({ to: 'B', note: '业主挂断测试', sender: { id: 'session-a' } });
const ownerLine = phone.lines.find((line) => line.id === ownerCall.lineId);
const ownerHangup = await phone.hangupLine(ownerLine.id, { id: 'owner-page' });
assert(ownerHangup.ok === true, 'owner page must be able to hang up any line');
assert(ownerLine.status === 'closed' && ownerLine.reason === 'hangup', 'owner hangup should close the line');
await new Promise((resolve) => setTimeout(resolve, 80));
const ownerAudit = readFileSync(join(process.env.DSH_HOME, 'telephone', 'audit.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .find((entry) => entry.action === 'line-closed' && entry.line === ownerLine.id);
assert(ownerAudit?.closedBy === 'owner-page', 'owner page hangup should be audited as owner-page');

const stateFile = readFileSync(join(process.env.DSH_HOME, 'telephone', 'state.json'), 'utf8');
assert(stateFile.includes('"links"'), 'state should persist');
assert(sent.length > 0 && sent.every((input) => input.replyInstruction?.includes('phone_call')), 'delivery must tell the peer to reply with phone_call');
assert(sent.every((input) => !input.replyInstruction?.includes('bus_send')), 'delivery must not advertise bus_send');

console.log('phone smoke OK');
