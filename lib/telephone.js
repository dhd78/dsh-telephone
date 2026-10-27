/**
 * Telephone core: phonebook, owner-granted line quota, and per-pair lines.
 *
 * The transport (cold resume, followup, permission handling, audit of the
 * underlying bus) stays in `lib/bus.js`, derived from dsh-session-bus. This file
 * owns the product layer the owner asked for:
 *
 *   - a fixed, visually drawn phonebook of allowed pairs;
 *   - one active line per pair;
 *   - a line counter (first call = 1) bounded by the edge's maxRounds;
 *   - per-session "line creation quota" granted only from the plugin page;
 *   - 60 minutes of inactivity -> auto hangup;
 *   - a quiet notice when a line closes, and nothing when the peer is offline.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = 1;
const IDLE_MS = 60 * 60 * 1000;
const MAX_NOTE = 100;
const MIN_ROUNDS = 2;
const MAX_ROUNDS = 30;
const SAVE_DEBOUNCE_MS = 250;

export class PhoneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneError';
    this.code = code;
  }
}

export function createTelephone(options) {
  return new Telephone(options);
}

class Telephone {
  constructor({ ctx, bus, config, logger }) {
    this.ctx = ctx;
    this.bus = bus;
    this.config = config ?? {};
    this.logger = logger ?? {};
    this.roster = {};
    this.links = [];
    this.quotas = {};
    this.lines = [];
    this.settings = { allowColdResume: true };
    this.saveTimer = null;
    this.saveChain = Promise.resolve();
    this.home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
    this.dir = join(this.home, 'telephone');
    this.statePath = join(this.dir, 'state.json');
    this.auditPath = join(this.dir, 'audit.jsonl');
    this.#load();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  #load() {
    try {
      const data = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (data && typeof data === 'object') {
        if (data.roster && typeof data.roster === 'object') {
          for (const [sessionId, entry] of Object.entries(data.roster)) {
            if (typeof entry?.alias === 'string' && entry.alias.trim() !== '') {
              this.roster[sessionId] = {
                alias: entry.alias.trim().slice(0, 40),
                enabled: entry.enabled !== false,
              };
            }
          }
        }
        if (Array.isArray(data.links)) {
          const seen = new Set();
          for (const link of data.links) {
            if (!link || typeof link.a !== 'string' || typeof link.b !== 'string' || link.a === link.b) continue;
            const pair = pairOf(link.a, link.b);
            if (seen.has(pair.key)) continue;
            const max = clampInt(link.max, 6, MIN_ROUNDS, MAX_ROUNDS);
            seen.add(pair.key);
            this.links.push({ a: pair.a, b: pair.b, max });
          }
        }
        if (data.quotas && typeof data.quotas === 'object') {
          for (const [sessionId, value] of Object.entries(data.quotas)) {
            const quota = toInt(value, 0, 0, 999);
            if (quota > 0) this.quotas[sessionId] = quota;
          }
        }
        if (data.settings && typeof data.settings === 'object') {
          this.settings.allowColdResume = data.settings.allowColdResume !== false;
        }
        if (Array.isArray(data.lines)) {
          for (const line of data.lines) {
            if (!line || typeof line.id !== 'string' || typeof line.a !== 'string' || typeof line.b !== 'string') continue;
            if (line.a === line.b) continue;
            const status = line.status === 'active' ? 'active' : 'closed';
            this.lines.push({
              id: line.id,
              a: line.a,
              b: line.b,
              busThreadId: typeof line.busThreadId === 'string' ? line.busThreadId : null,
              count: toInt(line.count, 0, 0, MAX_ROUNDS),
              max: clampInt(line.max, 6, MIN_ROUNDS, MAX_ROUNDS),
              status,
              createdAt: toInt(line.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
              lastAt: toInt(line.lastAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
              closedAt: line.closedAt === undefined ? undefined : toInt(line.closedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
              reason: typeof line.reason === 'string' ? line.reason : undefined,
            });
          }
        }
      }
    } catch {
      // First run, or a hand-edited file that is not valid JSON: start clean.
    }
    this.#pruneLines();
  }

  #serialize() {
    return {
      version: VERSION,
      roster: this.roster,
      links: this.links,
      quotas: this.quotas,
      settings: this.settings,
      lines: this.lines.slice(-200),
    };
  }

  #scheduleSave() {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer?.unref === 'function') this.saveTimer.unref();
  }

  async save() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const text = `${JSON.stringify(this.#serialize(), null, 2)}\n`;
    this.saveChain = this.saveChain
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const temp = `${this.statePath}.tmp`;
        await writeFile(temp, text, 'utf8');
        await rename(temp, this.statePath);
      })
      .catch((error) => {
        this.logger.warn?.(`telephone: could not save state: ${String(error)}`);
      });
    return this.saveChain;
  }

  // -------------------------------------------------------------------------
  // Read surface
  // -------------------------------------------------------------------------

  async snapshot() {
    this.expire();
    const rows = await this.bus.rows();
    const sessions = rows
      .filter((row) => row.targetable !== false)
      .map((row) => {
        const entry = this.roster[row.sessionId];
        return {
          sessionId: row.sessionId,
          title: row.title ?? '',
          alias: entry?.alias ?? defaultAlias(row),
          enabled: entry?.enabled !== false,
          inPhonebook: entry !== undefined,
          running: row.running === true,
          live: row.agentAvailable === true,
          cwd: row.cwd ?? '',
          quota: this.quotaOf(row.sessionId),
        };
      });
    const known = new Set(sessions.map((session) => session.sessionId));
    const links = this.links.filter((link) => known.has(link.a) && known.has(link.b));
    const lines = this.lines
      .filter((line) => line.status === 'active' || known.has(line.a) || known.has(line.b))
      .slice(-30)
      .map((line) => this.#lineView(line));
    return {
      ok: true,
      updatedAt: Date.now(),
      sessions,
      links,
      lines,
      settings: { allowColdResume: this.settings.allowColdResume !== false },
      maxNoteChars: MAX_NOTE,
      idleMinutes: IDLE_MS / 60000,
    };
  }

  async listFor(sender) {
    const rows = await this.bus.rows();
    const byId = new Map(rows.map((row) => [row.sessionId, row]));
    const peers = [];
    for (const link of this.links) {
      const peerId = link.a === sender?.id ? link.b : link.b === sender?.id ? link.a : undefined;
      if (peerId === undefined) continue;
      const row = byId.get(peerId);
      const entry = this.roster[peerId];
      const active = this.activeLine(sender.id, peerId);
      peers.push({
        sessionId: peerId,
        alias: entry?.alias ?? (row ? defaultAlias(row) : shortId(peerId)),
        title: row?.title ?? '',
        enabled: entry?.enabled !== false,
        quota: this.quotaOf(peerId),
        maxRounds: link.max,
        lineId: active?.id,
        count: active?.count ?? 0,
        remainingMs: active ? this.remainingMs(active) : 0,
      });
    }
    peers.sort((left, right) => left.alias.localeCompare(right.alias, 'zh'));
    return {
      self: sender?.id,
      quota: this.quotaOf(sender?.id),
      peers,
      lines: this.activeLinesFor(sender?.id).map((line) => this.#lineView(line)),
    };
  }

  async statusFor(sender) {
    return this.listFor(sender);
  }

  async resolveTarget(reference, sender) {
    const ref = typeof reference === 'string' ? reference.trim() : '';
    if (ref === '') throw new PhoneError('target-required', '缺少电话目标。');
    const byAlias = Object.entries(this.roster).find(
      ([, entry]) => entry.alias.toLowerCase() === ref.toLowerCase(),
    );
    if (byAlias !== undefined) {
      const [sessionId, entry] = byAlias;
      if (entry.enabled === false) throw new PhoneError('target-disabled', `住户 ${entry.alias} 的电话已停用。`);
      if (sender?.id === sessionId) throw new PhoneError('self-call', '不能打给自己。');
      return { sessionId, title: entry.alias };
    }
    const row = await this.bus.resolveTarget(ref, { selfId: sender?.id });
    if (sender?.id === row.sessionId) throw new PhoneError('self-call', '不能打给自己。');
    const entry = this.roster[row.sessionId];
    if (entry?.enabled === false) throw new PhoneError('target-disabled', `住户 ${entry.alias} 的电话已停用。`);
    return row;
  }

  // -------------------------------------------------------------------------
  // Owner actions (called by the plugin page routes, never by an agent tool)
  // -------------------------------------------------------------------------

  async saveRoster(entries) {
    if (!Array.isArray(entries)) throw new PhoneError('bad-roster', '电话簿格式不对。');
    const rows = await this.bus.rows();
    const known = new Set(rows.filter((row) => row.targetable !== false).map((row) => row.sessionId));
    const next = { ...this.roster };
    const aliases = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry.sessionId !== 'string' || !known.has(entry.sessionId)) {
        throw new PhoneError('bad-session', '电话簿里有不存在的会话。');
      }
      const alias = typeof entry.alias === 'string' ? entry.alias.trim() : '';
      if (alias === '' || alias.length > 40) throw new PhoneError('bad-alias', '电话别名需要 1–40 个字。');
      if (aliases.has(alias.toLowerCase())) throw new PhoneError('duplicate-alias', `电话别名重复：${alias}`);
      aliases.set(alias.toLowerCase(), entry.sessionId);
      next[entry.sessionId] = { alias, enabled: entry.enabled !== false };
    }
    this.roster = next;
    await this.save();
    return this.snapshot();
  }

  async saveLinks(links) {
    if (!Array.isArray(links)) throw new PhoneError('bad-links', '连线格式不对。');
    const rows = await this.bus.rows();
    const known = new Set(rows.filter((row) => row.targetable !== false).map((row) => row.sessionId));
    const seen = new Set();
    const next = [];
    for (const link of links) {
      if (!link || typeof link.a !== 'string' || typeof link.b !== 'string' || link.a === link.b) {
        throw new PhoneError('bad-link', '一条连线需要两个不同的会话。');
      }
      if (!known.has(link.a) || !known.has(link.b)) throw new PhoneError('bad-link', '连线里有不存在的会话。');
      const pair = pairOf(link.a, link.b);
      if (seen.has(pair.key)) throw new PhoneError('duplicate-link', '这两个住户之间已经有一条线。');
      seen.add(pair.key);
      next.push({ a: pair.a, b: pair.b, max: clampInt(link.max, 6, MIN_ROUNDS, MAX_ROUNDS) });
    }
    this.links = next;
    await this.save();
    return this.snapshot();
  }

  async removeFromRoster(sessionId) {
    if (typeof sessionId !== 'string' || this.roster[sessionId] === undefined) {
      throw new PhoneError('not-in-phonebook', '这个会话不在电话簿里。');
    }
    const affected = this.lines.filter(
      (line) => line.status === 'active' && (line.a === sessionId || line.b === sessionId),
    );
    for (const line of affected) this.closeLine(line, 'unlink', 'owner-page');
    delete this.roster[sessionId];
    delete this.quotas[sessionId];
    this.links = this.links.filter((link) => link.a !== sessionId && link.b !== sessionId);
    await this.save();
    return this.snapshot();
  }

  async setQuota(sessionId, value) {
    const rows = await this.bus.rows();
    const known = new Set(rows.filter((row) => row.targetable !== false).map((row) => row.sessionId));
    if (!known.has(sessionId)) throw new PhoneError('bad-session', '没有这个会话。');
    const quota = toInt(value, 0, 0, 999);
    if (quota > 0) this.quotas[sessionId] = quota;
    else delete this.quotas[sessionId];
    await this.save();
    return this.snapshot();
  }

  async setAllowColdResume(value) {
    if (typeof value !== 'boolean') throw new PhoneError('bad-setting', '离线唤醒开关需要布尔值。');
    this.settings.allowColdResume = value;
    await this.save();
    return this.snapshot();
  }

  async isLive(sessionId) {
    const rows = await this.bus.rows();
    return rows.some((row) => row.sessionId === sessionId && row.agentAvailable === true);
  }

  async hangupLine(lineId, sender) {
    const isOwner = sender?.id === 'owner-page';
    const line = lineId === undefined
      ? this.activeLinesFor(sender?.id)[0]
      : this.lines.find((item) => item.id === lineId);
    if (line === undefined) throw new PhoneError('line-not-found', '没有找到这条专线。');
    if (line.status !== 'active') throw new PhoneError('line-closed', '这条专线已经结束了。');
    if (!isOwner && sender?.id !== undefined && line.a !== sender.id && line.b !== sender.id) {
      throw new PhoneError('not-participant', '你不在这个专线里。');
    }
    this.closeLine(line, 'hangup', isOwner ? 'owner-page' : sender?.id ?? 'unknown');
    await this.save();
    return { ok: true, lineId: line.id, reason: 'hangup' };
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  async call(input) {
    const sender = input.sender;
    if (!sender || typeof sender.id !== 'string' || sender.id === '') {
      throw new PhoneError('sender-missing', '找不到当前会话，不能打电话。');
    }
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    const noteLength = [...note].length;
    if (noteLength < 1) throw new PhoneError('note-empty', '电话内容不能为空。');
    if (noteLength > MAX_NOTE) throw new PhoneError('note-too-long', `电话内容最多 ${MAX_NOTE} 个字。`);
    const target = await this.resolveTarget(input.to, sender);
    if (target.sessionId === sender.id) throw new PhoneError('self-call', '不能打给自己。');
    if (this.settings.allowColdResume !== true && !(await this.isLive(target.sessionId))) {
      throw new PhoneError('cold-resume-disabled', '目标会话当前不在线，且业主关闭了离线唤醒；请改走邮箱或等对方上线。');
    }
    const link = this.linkFor(sender.id, target.sessionId);
    if (link === undefined) throw new PhoneError('no-link', '这两个住户之间没有接线，先请业主在插件页画线。');

    let line = input.line === undefined
      ? this.activeLine(sender.id, target.sessionId)
      : this.lines.find((item) => item.id === input.line);
    if (line !== undefined && line.status !== 'active') line = undefined;
    if (line !== undefined && line.a !== sender.id && line.b !== sender.id) {
      throw new PhoneError('not-participant', '你不在这个专线里。');
    }
    if (line !== undefined && (line.a !== target.sessionId && line.b !== target.sessionId)) {
      throw new PhoneError('wrong-line', '这条专线不是打给这个住户的。');
    }
    if (line !== undefined && line.count >= line.max) {
      this.closeLine(line, 'max', sender.id);
      line = undefined;
    }

    let created = false;
    if (line === undefined) {
      const quota = this.quotaOf(sender.id);
      if (quota <= 0) {
        throw new PhoneError('quota-empty', '没有专线创建次数，请业主在电话插件页分配。');
      }
      line = {
        id: `line-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        a: sender.id,
        b: target.sessionId,
        busThreadId: null,
        count: 0,
        max: link.max,
        status: 'active',
        createdAt: Date.now(),
        lastAt: Date.now(),
      };
      this.lines.push(line);
      created = true;
    }

    const text = this.#envelope(sender, target, line, note);
    let receipt;
    try {
      receipt = await this.bus.send({
        to: target.sessionId,
        message: text,
        mode: 'queue',
        threadId: line.busThreadId ?? undefined,
        replyInstruction: [
          '请用 phone_call 回电：',
          `phone_call({ to: "${sender.id}", line: "${line.id}", note: "<结果，最多100字>" })`,
          '任务细节写进对方信箱；电话只回电说结果或“已看信”。',
        ].join('\n'),
        sender,
        signal: input.signal,
      });
    } catch (error) {
      if (created) {
        this.lines = this.lines.filter((item) => item !== line);
      }
      throw error instanceof PhoneError ? error : new PhoneError('delivery-failed', `电话没有接通：${String(error?.message ?? error)}`);
    }

    if (created) {
      line.busThreadId = typeof receipt?.threadId === 'string' ? receipt.threadId : null;
      this.quotas[sender.id] = Math.max(0, this.quotaOf(sender.id) - 1);
      if (this.quotas[sender.id] === 0) delete this.quotas[sender.id];
    }
    line.count += 1;
    line.lastAt = Date.now();
    let closed = false;
    if (line.count >= line.max) {
      this.closeLine(line, 'max', sender.id);
      closed = true;
    }
    this.#audit({ action: 'call', from: sender.id, to: target.sessionId, line: line.id, count: line.count, max: line.max, created, closed });
    await this.save();
    return {
      ok: true,
      delivered: true,
      target: target.sessionId,
      targetTitle: target.title ?? this.roster[target.sessionId]?.alias ?? shortId(target.sessionId),
      lineId: line.id,
      count: line.count,
      max: line.max,
      quotaLeft: this.quotaOf(sender.id),
      closed,
      remainingMs: closed ? 0 : this.remainingMs(line),
    };
  }

  // -------------------------------------------------------------------------
  // Expiry / line lifecycle
  // -------------------------------------------------------------------------

  expire() {
    const now = Date.now();
    let changed = false;
    for (const line of this.lines) {
      if (line.status !== 'active') continue;
      if (now - line.lastAt >= IDLE_MS) {
        this.closeLine(line, 'idle', 'system');
        changed = true;
      }
    }
    if (changed) this.#scheduleSave();
  }

  closeLine(line, reason, closedBy = 'system') {
    if (line.status !== 'active') return;
    line.status = 'closed';
    line.closedAt = Date.now();
    line.reason = reason;
    const left = line.max - line.count;
    const text = `[电话] 专线 ${line.id} 已结束（${reasonText(reason)}）。本专线已通话 ${line.count}/${line.max} 次${left > 0 ? `，剩余 ${left} 次` : ''}。`;
    void this.#notifyQuiet(line.a, text);
    if (line.b !== line.a) void this.#notifyQuiet(line.b, text);
    this.#audit({
      action: 'line-closed',
      line: line.id,
      from: line.a,
      to: line.b,
      closedBy: typeof closedBy === 'string' && closedBy !== '' ? closedBy : 'system',
      count: line.count,
      max: line.max,
      reason,
    });
    this.#scheduleSave();
  }

  activeLine(a, b) {
    const pair = pairOf(a, b);
    return this.lines.find(
      (line) => line.status === 'active' && pairOf(line.a, line.b).key === pair.key,
    );
  }

  activeLinesFor(sessionId) {
    if (typeof sessionId !== 'string') return [];
    return this.lines
      .filter((line) => line.status === 'active' && (line.a === sessionId || line.b === sessionId))
      .sort((left, right) => right.lastAt - left.lastAt);
  }

  remainingMs(line) {
    return Math.max(0, IDLE_MS - (Date.now() - line.lastAt));
  }

  quotaOf(sessionId) {
    const value = this.quotas[sessionId];
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  aliasOf(sessionId) {
    return this.roster[sessionId]?.alias ?? shortId(sessionId);
  }

  linkFor(a, b) {
    const pair = pairOf(a, b);
    return this.links.find((link) => pairOf(link.a, link.b).key === pair.key);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #lineView(line) {
    return {
      id: line.id,
      a: line.a,
      b: line.b,
      count: line.count,
      max: line.max,
      status: line.status,
      lastAt: line.lastAt,
      closedAt: line.closedAt,
      reason: line.reason,
      remainingMs: line.status === 'active' ? this.remainingMs(line) : 0,
    };
  }

  #envelope(sender, target, line, note) {
    const from = this.roster[sender.id]?.alias ?? shortId(sender.id);
    return [
      `[电话] 来自 ${from}（${sender.id}）；专线 ${line.id}。`,
      `请查看你信箱：${note}`,
      `回电请用 phone_call({ to: "${sender.id}", line: "${line.id}" })；任务细节放信箱，电话只说这些。`,
    ].join('\n');
  }

  async #notifyQuiet(sessionId, text) {
    // Deliberately never resumes a cold Session: an offline peer is not disturbed.
    try {
      const agents = this.ctx.get?.('agents') ?? this.ctx.agents;
      const agent = agents?.get?.(sessionId);
      if (agent === undefined || agent === null || typeof agent.inject !== 'function') return;
      const result = agent.inject({
        // DSH derives the LLM message from this event verbatim: a user/message
        // without role/id makes every later request fail with 422 missing role.
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'telephone', form: 'notice' },
      });
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          this.logger.debug?.(`telephone: quiet notice rejected: ${String(error)}`);
        });
      }
    } catch (error) {
      this.logger.debug?.(`telephone: quiet notice skipped: ${String(error)}`);
    }
  }

  async #audit(record) {
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
    } catch {
      // Audit is best-effort; a full disk must not break a call.
    }
  }

  #pruneLines() {
    // Keep the active set plus the last 80 closed lines for the panel and audit.
    const closed = this.lines.filter((line) => line.status !== 'active');
    const active = this.lines.filter((line) => line.status === 'active');
    this.lines = [...closed.slice(-80), ...active];
  }
}

function pairOf(a, b) {
  return a < b ? { a, b, key: `${a}\u0000${b}` } : { a: b, b: a, key: `${b}\u0000${a}` };
}

function defaultAlias(row) {
  if (typeof row?.title === 'string' && row.title.trim() !== '') return row.title.trim().slice(0, 40);
  return shortId(row?.sessionId);
}

function shortId(sessionId) {
  if (typeof sessionId !== 'string') return 'unknown';
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

function clampInt(value, fallback, min, max) {
  const integer = toInt(value, fallback, min, max);
  return integer;
}

function toInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function reasonText(reason) {
  if (reason === 'max') return '达到最大通话次数';
  if (reason === 'idle') return '60 分钟无通话，自动挂断';
  if (reason === 'hangup') return '主动挂断';
  if (reason === 'unlink') return '住户被移出电话簿';
  return reason;
}
