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
import { MailboxError, MailboxStore } from './mailbox.js';

const VERSION = 2;
const IDLE_MS = 60 * 60 * 1000;
const MAX_NOTE = 100;
const MIN_ROUNDS = 2;
const MAX_ROUNDS = 30;
const SAVE_DEBOUNCE_MS = 250;
const MAX_CALL_RECORDS = 300;
const MAX_MAIL_PER_HOUR = 1000;
const DELIVERY_MODES = new Set(['queue', 'steer', 'quiet']);
const PRIORITIES = new Set(['urgent', 'normal', 'low']);

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
    this.unlimited = new Set();
    this.lines = [];
    this.mailboxes = {};
    this.calls = [];
    this.settings = {
      allowColdResume: true,
      defaultDelivery: 'queue',
      defaultPriority: 'normal',
      maxCallsPerHour: 5,
      allowUrgentThroughDnd: false,
      dnd: {},
      quietHours: { enabled: false, start: '23:30', end: '08:00' },
    };
    this.saveTimer = null;
    this.saveChain = Promise.resolve();
    this.home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
    this.dir = join(this.home, 'telephone');
    this.statePath = join(this.dir, 'state.json');
    this.auditPath = join(this.dir, 'audit.jsonl');
    this.mailboxStore = new MailboxStore({ root: join(this.dir, 'mailboxes'), logger: this.logger });
    this.#load();
    void this.#ensureMailboxes();
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
                mailboxId: typeof entry.mailboxId === 'string' ? entry.mailboxId : undefined,
              };
            }
          }
        }
        if (data.mailboxes && typeof data.mailboxes === 'object') {
          for (const [mailboxId, entry] of Object.entries(data.mailboxes)) {
            if (!entry || typeof entry !== 'object') continue;
            this.mailboxes[mailboxId] = {
              id: mailboxId,
              sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
              createdAt: toInt(entry.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
              lastAt: toInt(entry.lastAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
            };
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
        if (Array.isArray(data.unlimited)) {
          for (const sessionId of data.unlimited) {
            if (typeof sessionId === 'string' && sessionId !== '') this.unlimited.add(sessionId);
          }
        }
        if (data.settings && typeof data.settings === 'object') {
          this.settings.allowColdResume = data.settings.allowColdResume !== false;
          this.settings.defaultDelivery = DELIVERY_MODES.has(data.settings.defaultDelivery)
            ? data.settings.defaultDelivery
            : 'queue';
          this.settings.defaultPriority = PRIORITIES.has(data.settings.defaultPriority)
            ? data.settings.defaultPriority
            : 'normal';
          const rawRate = data.settings.maxCallsPerHour;
          this.settings.maxCallsPerHour = rawRate === null ? null : clampInt(rawRate, 5, 1, 100);
          this.settings.allowUrgentThroughDnd = data.settings.allowUrgentThroughDnd === true;
          this.settings.dnd = data.settings.dnd && typeof data.settings.dnd === 'object'
            ? Object.fromEntries(Object.entries(data.settings.dnd).filter(([, value]) => value === true))
            : {};
          const quiet = data.settings.quietHours;
          this.settings.quietHours = {
            enabled: quiet?.enabled === true,
            start: normalizeClock(quiet?.start, '23:30'),
            end: normalizeClock(quiet?.end, '08:00'),
          };
        }
        if (Array.isArray(data.calls)) {
          for (const call of data.calls.slice(-MAX_CALL_RECORDS)) {
            if (!call || typeof call.id !== 'string' || typeof call.from !== 'string' || typeof call.to !== 'string') continue;
            this.calls.push(this.#normalizeCall(call));
          }
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
              lastCallId: typeof line.lastCallId === 'string' ? line.lastCallId : null,
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
      unlimited: [...this.unlimited],
      settings: this.settings,
      lines: this.lines.slice(-200),
      mailboxes: this.mailboxes,
      calls: this.calls.slice(-MAX_CALL_RECORDS),
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
    const archived = this.#archivedSet();
    const sessions = await Promise.all(rows
      .filter((row) => row.targetable !== false && !archived.has(row.sessionId))
      .map(async (row) => {
        const entry = this.roster[row.sessionId];
        const mailbox = await this.#mailboxSummary(row.sessionId);
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
          unlimited: this.unlimited.has(row.sessionId),
          ...mailbox,
        };
      }));
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
      calls: this.calls.slice(-30).reverse().map((call) => this.#callView(call)),
      settings: {
        allowColdResume: this.settings.allowColdResume !== false,
        defaultDelivery: DELIVERY_MODES.has(this.settings.defaultDelivery) ? this.settings.defaultDelivery : 'queue',
        defaultPriority: PRIORITIES.has(this.settings.defaultPriority) ? this.settings.defaultPriority : 'normal',
        maxCallsPerHour: this.settings.maxCallsPerHour,
        allowUrgentThroughDnd: this.settings.allowUrgentThroughDnd === true,
        quietHours: this.settings.quietHours,
        dnd: this.settings.dnd,
      },
      mailboxRoot: this.mailboxStore.root,
      maxNoteChars: MAX_NOTE,
      idleMinutes: IDLE_MS / 60000,
    };
  }

  async listFor(sender) {
    const rows = await this.bus.rows();
    const archived = this.#archivedSet();
    const byId = new Map(rows.map((row) => [row.sessionId, row]));
    const peers = [];
    for (const link of this.links) {
      const peerId = link.a === sender?.id ? link.b : link.b === sender?.id ? link.a : undefined;
      if (peerId === undefined || archived.has(peerId)) continue;
      const row = byId.get(peerId);
      const entry = this.roster[peerId];
      const active = this.activeLine(sender.id, peerId);
      const mailbox = await this.#mailboxSummary(peerId);
      peers.push({
        sessionId: peerId,
        alias: entry?.alias ?? (row ? defaultAlias(row) : shortId(peerId)),
        title: row?.title ?? '',
        enabled: entry?.enabled !== false,
        quota: this.quotaOf(peerId),
        unlimited: this.unlimited.has(peerId),
        maxRounds: link.max,
        lineId: active?.id,
        count: active?.count ?? 0,
        remainingMs: active ? this.remainingMs(active) : 0,
        ...mailbox,
      });
    }
    peers.sort((left, right) => left.alias.localeCompare(right.alias, 'zh'));

    const mailPeers = [];
    for (const [peerId, entry] of Object.entries(this.roster)) {
      if (peerId === sender?.id || archived.has(peerId)) continue;
      const mailbox = await this.#mailboxSummary(peerId);
      mailPeers.push({
        sessionId: peerId,
        alias: entry.alias,
        enabled: entry.enabled !== false,
        hasLine: this.linkFor(sender?.id, peerId) !== undefined,
        ...mailbox,
      });
    }
    mailPeers.sort((left, right) => left.alias.localeCompare(right.alias, 'zh'));

    return {
      self: sender?.id,
      selfMailbox: await this.#mailboxSummary(sender?.id),
      quota: this.quotaOf(sender?.id),
      unlimited: this.unlimited.has(sender?.id),
      defaultDelivery: DELIVERY_MODES.has(this.settings.defaultDelivery) ? this.settings.defaultDelivery : 'queue',
      peers,
      mailPeers,
      lines: this.activeLinesFor(sender?.id).map((line) => this.#lineView(line)),
    };
  }

  async statusFor(sender) {
    const data = await this.listFor(sender);
    return {
      self: data.self,
      quota: data.quota,
      unlimited: data.unlimited,
      defaultDelivery: data.defaultDelivery,
      peers: data.peers,
      lines: data.lines,
      calls: this.calls
        .filter((call) => call.from === sender?.id || call.to === sender?.id)
        .slice(-20)
        .reverse()
        .map((call) => this.#callView(call)),
    };
  }

  async resolveTarget(reference, sender) {
    const ref = typeof reference === 'string' ? reference.trim() : '';
    if (ref === '') throw new PhoneError('target-required', '缺少电话目标。');
    const archived = this.#archivedSet();
    const byAlias = Object.entries(this.roster).find(
      ([, entry]) => entry.alias.toLowerCase() === ref.toLowerCase(),
    );
    if (byAlias !== undefined) {
      const [sessionId, entry] = byAlias;
      if (archived.has(sessionId)) throw new PhoneError('archived', '这个会话已归档，不能投信或呼叫。');
      if (entry.enabled === false) throw new PhoneError('target-disabled', `住户 ${entry.alias} 的电话已停用。`);
      if (sender?.id === sessionId) throw new PhoneError('self-call', '不能打给自己。');
      return { sessionId, title: entry.alias };
    }
    const row = await this.bus.resolveTarget(ref, { selfId: sender?.id });
    if (archived.has(row.sessionId)) throw new PhoneError('archived', '这个会话已归档，不能投信或呼叫。');
    if (sender?.id === row.sessionId) throw new PhoneError('self-call', '不能打给自己。');
    const entry = this.roster[row.sessionId];
    if (entry?.enabled === false) throw new PhoneError('target-disabled', `住户 ${entry.alias} 的电话已停用。`);
    return row;
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  get mailboxRoot() {
    return this.mailboxStore.root;
  }

  mailboxPathFor(mailboxId) {
    if (mailboxId === undefined || mailboxId === null || mailboxId === '') return this.mailboxStore.root;
    if (!this.mailboxes[mailboxId]) throw new PhoneError('mailbox-not-found', '没有这个邮箱。');
    return this.mailboxStore.pathFor(mailboxId);
  }

  async mailboxListFor(sender) {
    const sessionId = sender?.id;
    if (typeof sessionId !== 'string' || !this.roster[sessionId]) {
      throw new PhoneError('not-in-phonebook', '你还没有电话簿节点，不能使用邮箱。');
    }
    const mailboxId = this.#mailboxIdFor(sessionId);
    await this.mailboxStore.ensure(mailboxId);
    const data = await this.mailboxStore.list(mailboxId, { limit: 20 });
    return {
      self: sessionId,
      alias: this.roster[sessionId]?.alias ?? shortId(sessionId),
      ...data,
    };
  }

  async mailboxRead(sender, letterId) {
    const sessionId = sender?.id;
    if (typeof sessionId !== 'string' || !this.roster[sessionId]) {
      throw new PhoneError('not-in-phonebook', '你还没有电话簿节点，不能读取邮箱。');
    }
    const mailboxId = this.#mailboxIdFor(sessionId);
    const letter = await this.mailboxStore.read(mailboxId, letterId, { markRead: true });
    if (letter.callId) {
      const call = this.calls.find((item) => item.id === letter.callId);
      if (call && (call.state === 'queued' || call.state === 'delivered')) {
        call.state = 'read';
        call.updatedAt = Date.now();
      }
    }
    await this.save();
    await this.#audit({ action: 'mail-read', from: sessionId, mailboxId, letter: letterId });
    return {
      ok: true,
      letterId: letter.letterId,
      mailboxId,
      subject: letter.subject,
      from: letter.from,
      createdAt: letter.createdAt,
      state: letter.state,
      body: letter.body,
    };
  }

  async mailboxSend(input) {
    const sender = input.sender;
    const sessionId = sender?.id;
    if (typeof sessionId !== 'string' || !this.roster[sessionId]) {
      throw new PhoneError('not-in-phonebook', '你还没有电话簿节点，不能投信。');
    }
    const target = await this.resolveTarget(input.to, sender);
    if (!this.roster[target.sessionId]) {
      throw new PhoneError('not-in-phonebook', '收信人不在电话簿里，不能投信。');
    }
    const mailboxId = this.#mailboxIdFor(target.sessionId);
    await this.mailboxStore.ensure(mailboxId);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentFromSender = await this.mailboxStore.countSince(mailboxId, { from: sender.id, since: hourAgo });
    if (recentFromSender >= MAX_MAIL_PER_HOUR) {
      throw new PhoneError('mail-rate-limited', '这个收信人的邮箱近期收到的信太多了，请稍后再投。');
    }
    const priority = PRIORITIES.has(input.priority) ? input.priority : 'normal';
    const ttlMs = Number.isFinite(Number(input.ttlMs)) ? Math.max(0, Number(input.ttlMs)) : 0;
    const letter = await this.mailboxStore.send({
      mailboxId,
      from: sender.id,
      to: target.sessionId,
      subject: input.subject,
      body: input.body,
      priority,
      dedupeKey: input.dedupeKey,
      ttlMs,
    });
    await this.save();
    await this.#audit({
      action: 'mail-send',
      from: sessionId,
      to: target.sessionId,
      mailboxId,
      letter: letter.letterId,
      priority,
      deduped: letter.deduped === true,
    });
    return {
      ok: true,
      target: target.sessionId,
      targetTitle: this.roster[target.sessionId]?.alias ?? target.title ?? shortId(target.sessionId),
      mailboxId,
      ...letter,
    };
  }

  async setDnd(sessionId, value) {
    if (typeof sessionId !== 'string' || !this.roster[sessionId]) {
      throw new PhoneError('not-in-phonebook', '这个会话不在电话簿里。');
    }
    if (typeof value !== 'boolean') throw new PhoneError('bad-dnd', '静默开关需要布尔值。');
    if (value) this.settings.dnd[sessionId] = true;
    else delete this.settings.dnd[sessionId];
    await this.save();
    return this.snapshot();
  }

  async setQuietHours(value) {
    if (value === null || typeof value !== 'object') throw new PhoneError('bad-quiet', '静默时段格式不对。');
    this.settings.quietHours = {
      enabled: value.enabled === true,
      start: normalizeClock(value.start, this.settings.quietHours?.start ?? '23:30'),
      end: normalizeClock(value.end, this.settings.quietHours?.end ?? '08:00'),
    };
    await this.save();
    return this.snapshot();
  }

  async setMaxCallsPerHour(value) {
    if (value === null) {
      this.settings.maxCallsPerHour = null;
      await this.save();
      return this.snapshot();
    }
    const next = clampInt(value, this.settings.maxCallsPerHour, 1, 100);
    this.settings.maxCallsPerHour = next;
    await this.save();
    return this.snapshot();
  }

  #mailboxIdFor(sessionId) {
    if (typeof sessionId !== 'string' || !this.roster[sessionId]) return undefined;
    const entry = this.roster[sessionId];
    if (typeof entry.mailboxId === 'string' && this.mailboxes[entry.mailboxId]) return entry.mailboxId;
    const safe = shortId(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
    const mailboxId = `mbx_${safe}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    entry.mailboxId = mailboxId;
    this.mailboxes[mailboxId] = {
      id: mailboxId,
      sessionId,
      createdAt: Date.now(),
      lastAt: Date.now(),
    };
    return mailboxId;
  }

  async #mailboxSummary(sessionId) {
    if (typeof sessionId !== 'string' || !this.roster[sessionId]) {
      return { mailboxId: undefined, mailboxUnread: 0, dnd: false };
    }
    const mailboxId = this.#mailboxIdFor(sessionId);
    let list;
    try {
      await this.mailboxStore.ensure(mailboxId);
      list = await this.mailboxStore.list(mailboxId, { limit: 1 });
    } catch {
      list = { unread: 0, letters: [] };
    }
    return {
      mailboxId,
      mailboxUnread: list.unread,
      dnd: this.settings.dnd?.[sessionId] === true,
    };
  }

  async #ensureMailboxes() {
    try {
      for (const sessionId of Object.keys(this.roster)) {
        const mailboxId = this.#mailboxIdFor(sessionId);
        if (mailboxId !== undefined) await this.mailboxStore.ensure(mailboxId);
      }
      this.#scheduleSave();
    } catch (error) {
      this.logger.warn?.(`telephone: mailbox init failed: ${String(error)}`);
    }
  }

  #archivedSet() {
    try {
      const registry = this.ctx?.get?.('workspaceRegistry') ?? this.ctx?.workspaceRegistry;
      const ids = registry?.archivedSessionIds;
      return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  // -------------------------------------------------------------------------
  // Owner actions (called by the plugin page routes, never by an agent tool)
  // -------------------------------------------------------------------------

  async saveRoster(entries) {
    if (!Array.isArray(entries)) throw new PhoneError('bad-roster', '电话簿格式不对。');
    const rows = await this.bus.rows();
    const archived = this.#archivedSet();
    const known = new Set(rows.filter((row) => row.targetable !== false && !archived.has(row.sessionId)).map((row) => row.sessionId));
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
      const previous = this.roster[entry.sessionId];
      next[entry.sessionId] = {
        alias,
        enabled: entry.enabled !== false,
        mailboxId: previous?.mailboxId,
      };
    }
    for (const sessionId of Object.keys(next)) {
      if (archived.has(sessionId)) delete next[sessionId];
    }
    this.roster = next;
    await this.#ensureMailboxes();
    await this.save();
    return this.snapshot();
  }

  async saveLinks(links) {
    if (!Array.isArray(links)) throw new PhoneError('bad-links', '连线格式不对。');
    const rows = await this.bus.rows();
    const archived = this.#archivedSet();
    const known = new Set(rows.filter((row) => row.targetable !== false && !archived.has(row.sessionId)).map((row) => row.sessionId));
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
    const mailboxId = this.roster[sessionId]?.mailboxId;
    delete this.roster[sessionId];
    delete this.quotas[sessionId];
    delete this.settings.dnd[sessionId];
    this.links = this.links.filter((link) => link.a !== sessionId && link.b !== sessionId);
    if (mailboxId !== undefined) {
      try {
        await this.mailboxStore.archive(mailboxId);
        delete this.mailboxes[mailboxId];
      } catch (error) {
        this.logger.warn?.(`telephone: mailbox archive failed: ${String(error)}`);
      }
    }
    await this.save();
    return this.snapshot();
  }

  async setQuota(sessionId, value, unlimited) {
    const rows = await this.bus.rows();
    const archived = this.#archivedSet();
    const known = new Set(rows.filter((row) => row.targetable !== false && !archived.has(row.sessionId)).map((row) => row.sessionId));
    if (!known.has(sessionId)) throw new PhoneError('bad-session', '没有这个会话。');
    if (unlimited === true) {
      this.unlimited.add(sessionId);
      delete this.quotas[sessionId];
      await this.save();
      return this.snapshot();
    }
    if (unlimited === false) this.unlimited.delete(sessionId);
    const quota = toInt(value, 0, 0, 999);
    if (quota > 0) this.quotas[sessionId] = quota;
    else delete this.quotas[sessionId];
    await this.save();
    return this.snapshot();
  }

  async setDefaultDelivery(value) {
    if (!DELIVERY_MODES.has(value)) throw new PhoneError('bad-delivery', '投递方式只能是 queue、steer 或 quiet。');
    this.settings.defaultDelivery = value;
    await this.save();
    return this.snapshot();
  }

  async setDefaultPriority(value) {
    if (!PRIORITIES.has(value)) throw new PhoneError('bad-priority', '默认优先级只能是 urgent、normal 或 low。');
    this.settings.defaultPriority = value;
    await this.save();
    return this.snapshot();
  }

  async setUrgentThroughDnd(value) {
    if (typeof value !== 'boolean') throw new PhoneError('bad-setting', '紧急穿透开关需要布尔值。');
    this.settings.allowUrgentThroughDnd = value;
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

    const priority = PRIORITIES.has(input.priority) ? input.priority : (PRIORITIES.has(this.settings.defaultPriority) ? this.settings.defaultPriority : 'normal');
    const requestedDelivery = input.delivery === undefined
      ? (priority === 'low' ? 'quiet' : this.settings.defaultDelivery)
      : input.delivery;
    if (!DELIVERY_MODES.has(requestedDelivery)) throw new PhoneError('bad-delivery', '投递方式只能是 queue、steer 或 quiet。');
    const target = await this.resolveTarget(input.to, sender);
    if (target.sessionId === sender.id) throw new PhoneError('self-call', '不能打给自己。');
    const link = this.linkFor(sender.id, target.sessionId);
    if (link === undefined) throw new PhoneError('no-link', '这两个住户之间没有接线，先请业主在插件页画线。');

    const dedupeKey = typeof input.dedupeKey === 'string' ? input.dedupeKey.trim().slice(0, 80) : '';
    if (dedupeKey !== '') {
      const duplicate = this.calls.find((call) => call.from === sender.id
        && call.to === target.sessionId
        && call.dedupeKey === dedupeKey
        && !['expired', 'suppressed', 'failed'].includes(call.state));
      if (duplicate !== undefined) {
        return {
          ...this.#callResult(duplicate, sender, target, link),
          deduped: true,
        };
      }
    }

    const explicitQuiet = requestedDelivery === 'quiet';
    const blockReason = explicitQuiet ? 'quiet' : this.#suppressionReason(target.sessionId, priority);
    if (blockReason !== undefined) {
      const call = this.#recordCall({
        from: sender.id,
        to: target.sessionId,
        lineId: null,
        delivery: explicitQuiet ? 'quiet' : requestedDelivery,
        priority,
        dedupeKey,
        letterId: typeof input.letterId === 'string' ? input.letterId : undefined,
        state: 'suppressed',
        reason: blockReason,
        ttlMs: input.ttlMs,
      });
      await this.save();
      await this.#audit({
        action: 'call-suppressed',
        call: call.id,
        from: sender.id,
        to: target.sessionId,
        priority,
        delivery: call.delivery,
        reason: blockReason,
      });
      return {
        ...this.#callResult(call, sender, target, link),
        delivered: false,
        suppressed: true,
        deduped: false,
      };
    }

    if (this.settings.allowColdResume !== true && !(await this.isLive(target.sessionId))) {
      throw new PhoneError('cold-resume-disabled', '目标会话当前不在线，且业主关闭了离线唤醒；请改走邮箱或等对方上线。');
    }

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

    // A call from the other side is a reply to the previous outgoing call.
    if (line?.lastCallId !== undefined && line !== undefined) {
      const previous = this.calls.find((call) => call.id === line.lastCallId);
      if (previous !== undefined && previous.to === sender.id && previous.from !== sender.id
        && ['queued', 'delivered', 'read'].includes(previous.state)) {
        previous.state = 'replied';
        previous.updatedAt = Date.now();
      }
    }

    let created = false;
    if (line === undefined) {
      const quota = this.quotaOf(sender.id);
      if (!this.unlimited.has(sender.id) && quota <= 0) {
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
        lastCallId: null,
      };
      this.lines.push(line);
      created = true;
    }

    const call = this.#recordCall({
      from: sender.id,
      to: target.sessionId,
      lineId: line.id,
      delivery: requestedDelivery,
      priority,
      dedupeKey,
      letterId: typeof input.letterId === 'string' ? input.letterId : undefined,
      state: 'queued',
      ttlMs: input.ttlMs,
    });

    const text = this.#envelope(sender, target, line, note);
    let receipt;
    try {
      receipt = await this.bus.send({
        to: target.sessionId,
        message: text,
        mode: requestedDelivery === 'steer' ? 'steer' : 'queue',
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
      call.state = 'failed';
      call.updatedAt = Date.now();
      if (created) {
        this.lines = this.lines.filter((item) => item !== line);
      }
      await this.save();
      throw error instanceof PhoneError ? error : new PhoneError('delivery-failed', `电话没有接通：${String(error?.message ?? error)}`);
    }

    call.state = 'delivered';
    call.updatedAt = Date.now();
    line.lastCallId = call.id;
    if (created) {
      line.busThreadId = typeof receipt?.threadId === 'string' ? receipt.threadId : null;
      if (!this.unlimited.has(sender.id)) {
        this.quotas[sender.id] = Math.max(0, this.quotaOf(sender.id) - 1);
        if (this.quotas[sender.id] === 0) delete this.quotas[sender.id];
      }
    }
    line.count += 1;
    line.lastAt = Date.now();
    let closed = false;
    if (line.count >= line.max) {
      this.closeLine(line, 'max', sender.id);
      closed = true;
    }
    await this.save();
    await this.#audit({
      action: 'call',
      call: call.id,
      from: sender.id,
      to: target.sessionId,
      line: line.id,
      count: line.count,
      max: line.max,
      created,
      closed,
      delivery: requestedDelivery,
      priority,
      state: call.state,
    });
    return {
      ...this.#callResult(call, sender, target, link),
      closed,
      remainingMs: closed ? 0 : this.remainingMs(line),
      deduped: false,
    };
  }

  #recordCall({ from, to, lineId, delivery, priority, dedupeKey, letterId, state, reason, ttlMs }) {
    const now = Date.now();
    const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(0, Number(ttlMs)) : 0;
    const call = {
      id: `call-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      from,
      to,
      lineId,
      delivery,
      priority,
      dedupeKey: dedupeKey || undefined,
      letterId,
      state,
      reason,
      createdAt: now,
      updatedAt: now,
      expiresAt: ttl > 0 ? now + ttl : undefined,
    };
    this.calls.push(call);
    if (this.calls.length > MAX_CALL_RECORDS) this.calls = this.calls.slice(-MAX_CALL_RECORDS);
    return call;
  }

  #normalizeCall(call) {
    return {
      id: call.id,
      from: call.from,
      to: call.to,
      lineId: typeof call.lineId === 'string' ? call.lineId : null,
      delivery: DELIVERY_MODES.has(call.delivery) ? call.delivery : 'queue',
      priority: PRIORITIES.has(call.priority) ? call.priority : 'normal',
      dedupeKey: typeof call.dedupeKey === 'string' ? call.dedupeKey : undefined,
      letterId: typeof call.letterId === 'string' ? call.letterId : undefined,
      state: typeof call.state === 'string' ? call.state : 'queued',
      reason: typeof call.reason === 'string' ? call.reason : undefined,
      createdAt: toInt(call.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
      updatedAt: toInt(call.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
      expiresAt: call.expiresAt === undefined ? undefined : toInt(call.expiresAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    };
  }

  #callView(call) {
    return {
      callId: call.id,
      from: call.from,
      to: call.to,
      lineId: call.lineId ?? '',
      delivery: call.delivery,
      priority: call.priority,
      state: call.state,
      reason: call.reason,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      expiresAt: call.expiresAt,
      letterId: call.letterId,
    };
  }

  #callResult(call, sender, target, link) {
    const line = call.lineId ? this.lines.find((item) => item.id === call.lineId) : undefined;
    return {
      ok: true,
      delivered: call.state === 'delivered' || call.state === 'read' || call.state === 'replied',
      target: target.sessionId,
      targetTitle: target.title ?? this.roster[target.sessionId]?.alias ?? shortId(target.sessionId),
      lineId: call.lineId ?? '',
      count: line?.count ?? 0,
      max: line?.max ?? link?.max ?? 0,
      quotaLeft: this.quotaOf(sender.id),
      unlimited: this.unlimited.has(sender.id),
      delivery: call.delivery,
      priority: call.priority,
      callId: call.id,
      state: call.state,
      reason: call.reason,
      suppressed: call.state === 'suppressed',
      deduped: false,
      closed: line?.status === 'closed',
      remainingMs: line?.status === 'active' ? this.remainingMs(line) : 0,
    };
  }

  #suppressionReason(targetId, priority) {
    const urgentOverride = priority === 'urgent' && this.settings.allowUrgentThroughDnd === true;
    if (this.settings.dnd?.[targetId] === true && !urgentOverride) return 'dnd';
    if (this.#quietHoursActive() && !urgentOverride) return 'quiet-hours';
    const since = Date.now() - 60 * 60 * 1000;
    const recent = this.calls.filter((call) => call.to === targetId && call.createdAt >= since && call.state !== 'suppressed' && call.state !== 'failed').length;
    if (this.settings.maxCallsPerHour !== null && recent >= this.settings.maxCallsPerHour) return 'rate-limited';
    return undefined;
  }

  #quietHoursActive() {
    const quiet = this.settings.quietHours;
    if (quiet?.enabled !== true) return false;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const start = clockMinutes(quiet.start, 23 * 60 + 30);
    const end = clockMinutes(quiet.end, 8 * 60);
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
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
    for (const call of this.calls) {
      if (call.expiresAt === undefined) continue;
      if (!['queued', 'delivered', 'read'].includes(call.state)) continue;
      if (call.expiresAt > now) continue;
      call.state = 'expired';
      call.updatedAt = now;
      changed = true;
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

function normalizeClock(value, fallback) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value.trim())) return fallback;
  const [hour, minute] = value.trim().split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function clockMinutes(value, fallback) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) return fallback;
  const [hour, minute] = value.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return hour * 60 + minute;
}
