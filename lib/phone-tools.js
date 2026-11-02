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
          selfMailbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mailboxId: { type: 'string' },
              mailboxUnread: { type: 'integer' },
              dnd: { type: 'boolean' },
            },
            required: ['mailboxUnread', 'dnd'],
          },
          quota: { type: 'integer', description: 'Remaining owner-granted new-line creations for this Session.' },
          unlimited: { type: 'boolean' },
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
                unlimited: { type: 'boolean' },
                maxRounds: { type: 'integer' },
                lineId: { type: 'string', description: 'Active line to pass back on reply, when one exists.' },
                count: { type: 'integer' },
                remainingMs: { type: 'integer' },
                mailboxId: { type: 'string' },
                mailboxUnread: { type: 'integer' },
                dnd: { type: 'boolean' },
              },
              required: ['sessionId', 'alias', 'enabled', 'quota', 'maxRounds'],
            },
          },
          mailPeers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                alias: { type: 'string' },
                enabled: { type: 'boolean' },
                hasLine: { type: 'boolean' },
                mailboxId: { type: 'string' },
                mailboxUnread: { type: 'integer' },
                dnd: { type: 'boolean' },
              },
              required: ['sessionId', 'alias', 'enabled', 'hasLine'],
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
          `电话：你还有 ${value.unlimited ? '∞（软无限）' : value.quota} 次新建专线配额。`,
          `你的邮箱：${value.selfMailbox?.mailboxId ?? '未分配'}，未读 ${value.selfMailbox?.mailboxUnread ?? 0}${value.selfMailbox?.dnd ? '，静默中' : ''}。`,
          value.peers.length === 0 ? '还没有任何接线；请业主在插件页画线。' : '可呼叫：',
        ];
        for (const peer of value.peers) {
          const state = peer.lineId === undefined
            ? `未接通；新建${peer.unlimited ? '不消耗总配额' : '消耗 1 次配额'}；最多 ${peer.maxRounds} 次`
            : `已有专线 ${peer.lineId}（${peer.count}/${peer.maxRounds}，约 ${Math.ceil(peer.remainingMs / 60000)} 分钟）`;
          lines.push(`- ${peer.alias}（${peer.sessionId}）${peer.enabled ? '' : ' [已停用]'}${peer.dnd ? ' [静默]' : ''}：${state}；邮箱 ${peer.mailboxUnread ?? 0} 未读`);
        }
        if ((value.mailPeers ?? []).length > 0) {
          lines.push('可投信（不要求接线）：');
          for (const peer of value.mailPeers) {
            lines.push(`- ${peer.alias}（${peer.sessionId}）${peer.dnd ? ' [静默]' : ''}；邮箱未读 ${peer.mailboxUnread ?? 0}`);
          }
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
      'Call another resident and wake them. Keep the note at 100 characters or less: say who you are, which letter in their mailbox to read, and when to call back. Do NOT put the task, code, or file contents in the call; write the mailbox letter first. If an active line exists, pass its line id when replying. Delivery defaults to the owner setting: queue waits for the current turn to end; steer inserts at the next safe step boundary inside the current turn. Neither hard-aborts an in-flight tool. A cold resident is resumed.',
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
        delivery: {
          type: 'string',
          enum: ['queue', 'steer', 'quiet'],
          description: 'Optional override: queue = next full turn; steer = next safe step in the current turn; quiet = mailbox only, no ring. Omit to use the owner default (queue).',
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'normal', 'low'],
          description: 'Call priority. normal is the default; low defaults to quiet; urgent still respects owner DND unless explicitly allowed.',
        },
        dedupeKey: {
          type: 'string',
          description: 'Optional idempotency key. A second pending call with the same from/to/key returns the existing call instead of ringing again.',
        },
        ttlMs: {
          type: 'integer',
          description: 'Optional lifetime in milliseconds; an undelivered call expires after this time.',
        },
        letterId: {
          type: 'string',
          description: 'Optional mailbox letter id that this call refers to; body still stays in the mailbox.',
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
          unlimited: { type: 'boolean' },
          delivery: { type: 'string' },
          closed: { type: 'boolean' },
          remainingMs: { type: 'integer' },
          callId: { type: 'string' },
          state: { type: 'string' },
          priority: { type: 'string' },
          suppressed: { type: 'boolean' },
          deduped: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['ok', 'delivered', 'target', 'lineId', 'count', 'max', 'quotaLeft', 'closed', 'remainingMs'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.suppressed
            ? `已投递到邮箱，未响铃（${value.reason ?? 'quiet'}）。`
            : `已接通 ${value.targetTitle ?? value.target}。专线 ${value.lineId}：${value.count}/${value.max}。`,
          `优先级：${value.priority ?? 'normal'}；投递：${value.delivery === 'steer' ? '插话（下一安全步骤）' : value.delivery === 'quiet' ? '仅邮箱' : '排队（下一回合）'}。`,
          value.deduped ? '相同 dedupeKey 的呼叫已存在，本次没有重复响铃。' : null,
          value.closed ? '这条专线已达上限并结束；再打需要业主分配新的创建次数。' : null,
          value.suppressed ? '任务细节在邮箱里；需要叫醒时请改用 queue/steer。' : '任务细节请走对方信箱；电话只叫醒。',
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute(args, exec) {
      return phone.call({
        to: args.to,
        note: args.note,
        line: args.line,
        delivery: args.delivery,
        priority: args.priority,
        dedupeKey: args.dedupeKey,
        ttlMs: args.ttlMs,
        letterId: args.letterId,
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
          unlimited: { type: 'boolean' },
          defaultDelivery: { type: 'string' },
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
                unlimited: { type: 'boolean' },
                maxRounds: { type: 'integer' },
                lineId: { type: 'string' },
                count: { type: 'integer' },
                remainingMs: { type: 'integer' },
                mailboxId: { type: 'string' },
                mailboxUnread: { type: 'integer' },
                dnd: { type: 'boolean' },
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
          calls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                callId: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                lineId: { type: 'string' },
                delivery: { type: 'string' },
                priority: { type: 'string' },
                state: { type: 'string' },
                reason: { type: 'string' },
                createdAt: { type: 'integer' },
                updatedAt: { type: 'integer' },
                expiresAt: { type: 'integer' },
                letterId: { type: 'string' },
              },
              required: ['callId', 'from', 'to', 'state', 'priority'],
            },
          },
        },
        required: ['self', 'quota', 'peers', 'lines'],
      },
      render: (_args, value) => {
        const lines = [`电话：剩余新建专线配额 ${value.unlimited ? '∞（软无限）' : value.quota}。`];
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
    name: 'phone_mailbox_list',
    description:
      'List your own mailbox: unread count and recent letter metadata. This is read-only and does not wake anyone. Use phone_mailbox_read to read a letter body.',
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
          alias: { type: 'string' },
          mailboxId: { type: 'string' },
          unread: { type: 'integer' },
          letters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                letterId: { type: 'string' },
                mailboxId: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                callId: { type: 'string' },
                subject: { type: 'string' },
                preview: { type: 'string' },
                priority: { type: 'string' },
                state: { type: 'string' },
                createdAt: { type: 'integer' },
                expiresAt: { type: 'integer' },
              },
              required: ['letterId', 'from', 'subject', 'state'],
            },
          },
        },
        required: ['self', 'mailboxId', 'unread', 'letters'],
      },
      render: (_args, value) => {
        const lines = [`${value.alias ?? value.self} 的邮箱 ${value.mailboxId}：${value.unread} 封未读。`];
        for (const letter of value.letters) {
          lines.push(`- ${letter.letterId} [${letter.state}] ${letter.from}：${letter.subject}（${new Date(letter.createdAt).toLocaleString()}）`);
        }
        if (value.letters.length === 0) lines.push('暂无信件。');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      return phone.mailboxListFor(senderOf(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'phone_mailbox_read',
    description:
      'Read one letter from your own mailbox and mark it read. You cannot read another resident\'s mailbox. The body stays in this tool result; it is not written to the telephone audit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        letterId: { type: 'string', description: 'Letter id from phone_mailbox_list.' },
      },
      required: ['letterId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          letterId: { type: 'string' },
          mailboxId: { type: 'string' },
          subject: { type: 'string' },
          from: { type: 'string' },
          createdAt: { type: 'integer' },
          state: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['ok', 'letterId', 'mailboxId', 'subject', 'from', 'state', 'body'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `信 ${value.letterId}｜${value.subject}\n来自：${value.from}\n\n${value.body}`,
      }],
    },
    async execute(args, exec) {
      return phone.mailboxRead(senderOf(exec), args.letterId);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'phone_mailbox_send',
    description:
      'Send a letter to any resident in the phonebook. A telephone line is NOT required for mail. The body goes only to the target mailbox; the telephone audit records metadata only. To wake the target, call phone_call separately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Target resident alias from phone_list.' },
        subject: { type: 'string', description: 'Short subject, at most 120 characters.' },
        body: { type: 'string', description: 'Letter body. Stored only in the target mailbox.' },
        priority: { type: 'string', enum: ['urgent', 'normal', 'low'], description: 'Mail priority metadata; does not ring by itself.' },
        dedupeKey: { type: 'string', description: 'Optional idempotency key; a pending letter with the same key is reused.' },
        ttlMs: { type: 'integer', description: 'Optional letter lifetime in milliseconds.' },
      },
      required: ['to', 'subject', 'body'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          targetTitle: { type: 'string' },
          mailboxId: { type: 'string' },
          letterId: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          preview: { type: 'string' },
          priority: { type: 'string' },
          state: { type: 'string' },
          createdAt: { type: 'integer' },
          expiresAt: { type: 'integer' },
          deduped: { type: 'boolean' },
        },
        required: ['ok', 'target', 'mailboxId', 'letterId', 'state', 'deduped'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已投信到 ${value.targetTitle ?? value.target} 的邮箱 ${value.mailboxId}，信 ${value.letterId}（${value.state}${value.deduped ? '，去重合并' : ''}）。要叫醒对方，再调用 phone_call。`,
      }],
    },
    async execute(args, exec) {
      return phone.mailboxSend({
        to: args.to,
        subject: args.subject,
        body: args.body,
        priority: args.priority,
        dedupeKey: args.dedupeKey,
        ttlMs: args.ttlMs,
        sender: senderOf(exec),
      });
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
