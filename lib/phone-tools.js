/**
 * Model-facing telephone tools.
 *
 * These are intentionally small: the model can see who it may call, place a
 * short call, check its active lines, and hang up. Task details stay in the
 * existing mailbox; the call only says "look at the letter".
 */

import { defineTool } from './toolkit.js';

export function registerPhoneTools(ctx, phone) {
  const senderOf = (exec) => {
    const agent = exec.agent;
    const session = agent?.session;
    const id = typeof agent?.id === 'string' ? agent.id : undefined;
    return {
      id,
      title: id === undefined ? undefined : phone.aliasOf(id),
      cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
    };
  };

  const deadline = (exec) => withDeadline(exec.signal, 120000);

  ctx.tools.register(defineTool({
    name: 'phone_list',
    description:
      'List the residents you are allowed to call, your remaining line-creation quota, and your active telephone lines. Call this before phone_call so you use a real resident alias or session id, and so you know whether a line already exists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          self: { type: 'string' },
          quota: { type: 'integer', description: 'Remaining owner-granted new-line creations for this Session.' },
          peers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                alias: { type: 'string' },
                title: { type: 'string' },
                enabled: { type: 'boolean' },
                quota: { type: 'integer' },
                maxRounds: { type: 'integer' },
                lineId: { type: 'string', description: 'Active line to pass back on reply, when one exists.' },
                count: { type: 'integer' },
                remainingMs: { type: 'integer' },
              },
              required: ['sessionId', 'alias', 'enabled', 'quota', 'maxRounds'],
            },
          },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                a: { type: 'string' },
                b: { type: 'string' },
                count: { type: 'integer' },
                max: { type: 'integer' },
                remainingMs: { type: 'integer' },
              },
              required: ['id', 'a', 'b', 'count', 'max', 'remainingMs'],
            },
          },
        },
        required: ['self', 'quota', 'peers', 'lines'],
      },
      render: (_args, value) => {
        const lines = [
          `电话：你还有 ${value.quota} 次新建专线配额。`,
          value.peers.length === 0 ? '还没有任何接线；请业主在插件页画线。' : '可呼叫：',
        ];
        for (const peer of value.peers) {
          const state = peer.lineId === undefined
            ? `未接通；新建后消耗 1 次配额；最多 ${peer.maxRounds} 次`
            : `已有专线 ${peer.lineId}（${peer.count}/${peer.maxRounds}，约 ${Math.ceil(peer.remainingMs / 60000)} 分钟）`;
          lines.push(`- ${peer.alias}（${peer.sessionId}）${peer.enabled ? '' : ' [已停用]'}：${state}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      return phone.listFor(senderOf(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'phone_call',
    description:
      'Call another resident and wake them. Keep the note at 100 characters or less: say who you are, which letter in their mailbox to read, and when to call back. Do NOT put the task, code, or file contents in the call; write the mailbox letter first. If an active line exists, pass its line id when replying. A busy resident receives the call at its next turn; a cold resident is resumed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: {
          type: 'string',
          description: 'Resident alias from phone_list, or an exact DSH session id. Prefer the alias the owner assigned.',
        },
        note: {
          type: 'string',
          description: 'Call content, at most 100 characters. Only identity + which mailbox letter to read + call back. No task details.',
        },
        line: {
          type: 'string',
          description: 'Active line id from phone_list, required when calling back on an existing line. Omit for a new call.',
        },
      },
      required: ['to', 'note'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          delivered: { type: 'boolean' },
          target: { type: 'string' },
          targetTitle: { type: 'string' },
          lineId: { type: 'string' },
          count: { type: 'integer' },
          max: { type: 'integer' },
          quotaLeft: { type: 'integer' },
          closed: { type: 'boolean' },
          remainingMs: { type: 'integer' },
        },
        required: ['ok', 'delivered', 'target', 'lineId', 'count', 'max', 'quotaLeft', 'closed', 'remainingMs'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `已接通 ${value.targetTitle ?? value.target}。专线 ${value.lineId}：${value.count}/${value.max}。`,
          value.closed ? '这条专线已达上限并结束；再打需要业主分配新的创建次数。' : `剩余 ${Math.ceil(value.remainingMs / 60000)} 分钟；剩余配额 ${value.quotaLeft}。`,
          '任务细节请走对方信箱；电话只叫醒。',
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      return phone.call({
        to: args.to,
        note: args.note,
        line: args.line,
        sender: senderOf(exec),
        signal: deadline(exec),
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'phone_status',
    description:
      'Show the active telephone lines you are part of, how many calls each has used, how long is left, and your remaining new-line quota.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          self: { type: 'string' },
          quota: { type: 'integer' },
          peers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                alias: { type: 'string' },
                title: { type: 'string' },
                enabled: { type: 'boolean' },
                quota: { type: 'integer' },
                maxRounds: { type: 'integer' },
                lineId: { type: 'string' },
                count: { type: 'integer' },
                remainingMs: { type: 'integer' },
              },
              required: ['sessionId', 'alias', 'enabled', 'quota', 'maxRounds'],
            },
          },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                a: { type: 'string' },
                b: { type: 'string' },
                count: { type: 'integer' },
                max: { type: 'integer' },
                remainingMs: { type: 'integer' },
              },
              required: ['id', 'a', 'b', 'count', 'max', 'remainingMs'],
            },
          },
        },
        required: ['self', 'quota', 'peers', 'lines'],
      },
      render: (_args, value) => {
        const lines = [`电话：剩余新建专线配额 ${value.quota}。`];
        if (value.lines.length === 0) lines.push('当前没有活跃专线。');
        for (const line of value.lines) {
          lines.push(`- ${line.id} ${line.a} ↔ ${line.b}：${line.count}/${line.max}，约 ${Math.ceil(line.remainingMs / 60000)} 分钟`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      return phone.statusFor(senderOf(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'phone_hangup',
    description:
      'Hang up an active telephone line when the task is done. Omit line to hang up the most recently active line this Session is on. The line cannot be reused; a later call consumes a new owner-granted creation quota.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        line: { type: 'string', description: "Active line id. Omit to hang up this Session's most recent active line." },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          lineId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['ok', 'lineId', 'reason'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已挂断专线 ${value.lineId}（${value.reason}）。`,
      }],
    },
    async execute(args, exec) {
      return phone.hangupLine(args.line, senderOf(exec));
    },
  }));
}

function withDeadline(signal, timeoutMs) {
  if (signal === undefined) return AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any !== 'function') return signal;
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
