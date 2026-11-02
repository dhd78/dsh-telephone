/**
 * Mailbox storage for the Virtual Phone & Mailbox System.
 *
 * Mail is plain files under one mailbox directory:
 *   %DSH_HOME%/telephone/mailboxes/<mailboxId>/inbox/<letterId>.md
 *
 * The index carries metadata only. Letter bodies never enter the state file,
 * the phone audit, or the call envelope.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const MAILBOX_ID_RE = /^mbx_[A-Za-z0-9_-]{4,64}$/;
const LETTER_ID_RE = /^ltr_[A-Za-z0-9_-]{4,80}$/;
const MAX_SUBJECT = 120;
const MAX_BODY = 64 * 1024;
const MAX_LIST = 50;

export class MailboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailboxError';
    this.code = code;
  }
}

export class MailboxStore {
  constructor({ root, logger }) {
    this.root = resolve(root);
    this.logger = logger ?? {};
  }

  assertMailboxId(mailboxId) {
    if (typeof mailboxId !== 'string' || !MAILBOX_ID_RE.test(mailboxId)) {
      throw new MailboxError('bad-mailbox', '邮箱 id 格式不对。');
    }
    return mailboxId;
  }

  pathFor(mailboxId) {
    this.assertMailboxId(mailboxId);
    const target = resolve(this.root, mailboxId);
    assertInside(this.root, target);
    return target;
  }

  indexPath(mailboxId) {
    return join(this.pathFor(mailboxId), 'index.json');
  }

  async ensure(mailboxId) {
    const dir = this.pathFor(mailboxId);
    await mkdir(join(dir, 'inbox'), { recursive: true });
    await mkdir(join(dir, 'archive'), { recursive: true });
    if (!isFile(join(dir, 'index.json'))) {
      await this.#writeIndex(mailboxId, { version: 1, letters: [] });
    }
    return dir;
  }

  async #readIndex(mailboxId) {
    const path = this.indexPath(mailboxId);
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      const letters = Array.isArray(data?.letters)
        ? data.letters.filter((letter) => letter && typeof letter.id === 'string' && LETTER_ID_RE.test(letter.id))
        : [];
      return { version: 1, letters };
    } catch {
      return { version: 1, letters: [] };
    }
  }

  async #writeIndex(mailboxId, index) {
    const dir = this.pathFor(mailboxId);
    await mkdir(join(dir, 'inbox'), { recursive: true });
    const path = join(dir, 'index.json');
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  }

  async list(mailboxId, { limit = 20, unreadOnly = false } = {}) {
    await this.ensure(mailboxId);
    const index = await this.#readIndex(mailboxId);
    const now = Date.now();
    let changed = false;
    for (const letter of index.letters) {
      if (letter.state !== 'expired' && Number.isFinite(letter.expiresAt) && letter.expiresAt <= now) {
        letter.state = 'expired';
        changed = true;
      }
    }
    if (changed) await this.#writeIndex(mailboxId, index);
    const visible = index.letters
      .filter((letter) => !unreadOnly || letter.state === 'unread')
      .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
      .slice(0, Math.max(1, Math.min(MAX_LIST, Number(limit) || 20)))
      .map(publicLetter);
    return {
      mailboxId,
      unread: index.letters.filter((letter) => letter.state === 'unread').length,
      letters: visible,
    };
  }

  async send(input) {
    const mailboxId = this.assertMailboxId(input.mailboxId);
    const subject = cleanText(input.subject, MAX_SUBJECT);
    const body = typeof input.body === 'string' ? input.body : '';
    if (subject === '') throw new MailboxError('subject-empty', '信件标题不能为空。');
    if ([...body].length > MAX_BODY) throw new MailboxError('body-too-long', `信件正文最多 ${MAX_BODY} 个字符。`);
    await this.ensure(mailboxId);
    const index = await this.#readIndex(mailboxId);
    const dedupeKey = typeof input.dedupeKey === 'string' ? input.dedupeKey.trim().slice(0, 80) : '';
    if (dedupeKey !== '') {
      const existing = index.letters.find((letter) => letter.dedupeKey === dedupeKey && letter.state !== 'expired' && letter.state !== 'archived');
      if (existing !== undefined) return { ...publicLetter(existing), deduped: true };
    }

    const letterId = `ltr_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = Date.now();
    const ttl = Number.isFinite(Number(input.ttlMs)) ? Math.max(0, Number(input.ttlMs)) : 0;
    const letter = {
      id: letterId,
      mailboxId,
      from: cleanText(input.from, 120),
      to: cleanText(input.to, 120),
      callId: typeof input.callId === 'string' ? input.callId : undefined,
      subject,
      preview: cleanText(body.replace(/\s+/g, ' '), 120),
      file: `inbox/${letterId}.md`,
      priority: input.priority === 'urgent' || input.priority === 'low' ? input.priority : 'normal',
      dedupeKey: dedupeKey || undefined,
      state: 'unread',
      createdAt: now,
      expiresAt: ttl > 0 ? now + ttl : undefined,
    };
    await writeFile(join(this.pathFor(mailboxId), 'inbox', `${letterId}.md`), body, 'utf8');
    index.letters.push(letter);
    // Keep enough metadata to enforce the hourly mail cap; bodies stay on disk.
    if (index.letters.length > 2000) index.letters = index.letters.slice(-2000);
    await this.#writeIndex(mailboxId, index);
    return { ...publicLetter(letter), deduped: false };
  }

  async read(mailboxId, letterId, { markRead = true } = {}) {
    this.assertMailboxId(mailboxId);
    if (typeof letterId !== 'string' || !LETTER_ID_RE.test(letterId)) {
      throw new MailboxError('bad-letter', '信件 id 格式不对。');
    }
    await this.ensure(mailboxId);
    const index = await this.#readIndex(mailboxId);
    const letter = index.letters.find((item) => item.id === letterId);
    if (letter === undefined) throw new MailboxError('letter-not-found', '没有找到这封信。');
    const filePath = join(this.pathFor(mailboxId), letter.file);
    assertInside(this.pathFor(mailboxId), filePath);
    let body = '';
    try {
      body = await readFile(filePath, 'utf8');
    } catch {
      throw new MailboxError('letter-missing', '信件文件不存在。');
    }
    let changed = false;
    if (markRead && letter.state === 'unread') {
      letter.state = 'read';
      letter.readAt = Date.now();
      changed = true;
    }
    if (letter.state !== 'expired' && Number.isFinite(letter.expiresAt) && letter.expiresAt <= Date.now()) {
      letter.state = 'expired';
      changed = true;
    }
    if (changed) await this.#writeIndex(mailboxId, index);
    return { ...publicLetter(letter), body };
  }

  async countSince(mailboxId, { from, since } = {}) {
    await this.ensure(mailboxId);
    const index = await this.#readIndex(mailboxId);
    return index.letters.filter((letter) => {
      if (typeof from === 'string' && letter.from !== from) return false;
      return !Number.isFinite(since) || Number(letter.createdAt) >= since;
    }).length;
  }

  async markExpired(mailboxId) {
    await this.ensure(mailboxId);
    const index = await this.#readIndex(mailboxId);
    const now = Date.now();
    let changed = false;
    for (const letter of index.letters) {
      if (letter.state !== 'expired' && letter.state !== 'archived' && Number.isFinite(letter.expiresAt) && letter.expiresAt <= now) {
        letter.state = 'expired';
        changed = true;
      }
    }
    if (changed) await this.#writeIndex(mailboxId, index);
    return changed;
  }

  async archive(mailboxId) {
    const dir = this.pathFor(mailboxId);
    if (!isFile(join(dir, 'index.json'))) return false;
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const archived = `${dir}.archived-${stamp}`;
    await rename(dir, archived);
    return archived;
  }
}

function publicLetter(letter) {
  return {
    letterId: letter.id,
    mailboxId: letter.mailboxId,
    from: letter.from ?? '',
    to: letter.to ?? '',
    callId: letter.callId,
    subject: letter.subject ?? '',
    preview: letter.preview ?? '',
    priority: letter.priority ?? 'normal',
    state: letter.state ?? 'unread',
    createdAt: Number(letter.createdAt) || 0,
    expiresAt: Number(letter.expiresAt) || 0,
  };
}

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return [...text].slice(0, max).join('');
}

function assertInside(root, target) {
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
    throw new MailboxError('bad-path', '邮箱路径越界。');
  }
}

function isFile(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
