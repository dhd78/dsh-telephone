/**
 * dsh-telephone — a telephone switchboard for DSH sessions.
 *
 * Transport: the `dsh-session-bus` core (MIT) resumes a cold target, wakes an
 * idle one, and delivers an `agent-message`-sourced turn. Product layer: the
 * owner-drawn phonebook, per-session new-line quota, one active line per pair,
 * a per-line call counter/max, and 60-minute idle hangup.
 */

import { createSessionBus } from './lib/bus.js';
import { normalizeConfig } from './lib/config.js';
import { createTelephone } from './lib/telephone.js';
import { registerPhoneTools } from './lib/phone-tools.js';
import { registerPhoneRoutes } from './lib/routes.js';

/** Cordis plugin row name. */
export const name = 'telephone';

/** Services required before the switchboard can contribute. */
export const inject = ['tools', 'sessionController', 'webServer', 'agents', 'workspaceRegistry'];

const PROMPT = [
  '## Virtual Phone & Mailbox',
  'You can call another resident with `phone_call({ to, note, line?, delivery?, priority?, dedupeKey?, ttlMs?, letterId? })`. The `note` is at most 100 characters: say who you are, which letter in the other resident\'s mailbox to read, and when to call back. Task details, code, and files belong in the mailbox letter, never in the call.',
  'Mail and calls are separate: `phone_mailbox_send({ to, subject, body })` delivers to any phonebook node without a telephone line; `phone_mailbox_list` / `phone_mailbox_read` read your own mailbox. A call still needs an owner-drawn line.',
  'Delivery defaults to the owner setting: `queue` waits for the target\'s current full turn to end; `steer` inserts at the next safe step boundary inside its current turn; `quiet` only leaves mail and does not ring. Neither queue nor steer hard-aborts an in-flight tool. Do not use `steer` for routine work unless the owner asks.',
  '`priority` is urgent/normal/low; low defaults to quiet. Owner DND and quiet hours may suppress the ring even for urgent calls; a suppressed call still returns a call id and state. Use `dedupeKey` for the same work item so one notification does not ring repeatedly; `ttlMs` expires an undelivered call.',
  'Use `phone_list` first to see callable peers, mail-only peers, mailboxes, active lines, and your remaining new-line creation quota. When replying on an existing call, pass its `line` id back. A cold resident is resumed. Use `phone_hangup` when the task is done; a line also hangs up after 60 minutes with no call.',
].join('\n');

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig);
  if (!settings.enabled) {
    info(ctx, 'telephone is disabled by configuration');
    return;
  }

  const busConfig = normalizeConfig({
    ...settings,
    enabled: true,
    tools: false,
    promptSection: false,
    allowSpawn: false,
    allowCrossWorkspace: true,
    maxHops: 64,
    maxMessageChars: 4096,
    inboundPresentation: 'notice',
    targetPermission: 'delegate',
    audit: false,
    persistState: false,
  });
  const bus = createSessionBus({
    ctx,
    config: busConfig,
    logger: ctx.logger,
    persist: false,
  });
  bus.attach(ctx);

  const phone = createTelephone({
    ctx,
    bus,
    config: settings,
    logger: ctx.logger,
  });

  registerPhoneTools(ctx, phone);
  registerPhoneRoutes(ctx, phone, ctx.logger);

  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.systemPrompt.section({
      name: 'telephone',
      order: 75,
      interpolate: false,
      text: PROMPT,
    });
  });

  ctx.effect(() => {
    const timer = setInterval(() => phone.expire(), 60 * 1000);
    if (typeof timer?.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'telephone: idle expiry');

  ctx.effect(() => () => {
    void phone.save();
  }, 'telephone: persist state');

  info(ctx, 'telephone ready (phonebook + mailboxes, priority/quiet, receipts)');
}

function info(ctx, message) {
  if (typeof ctx.logger?.info === 'function') ctx.logger.info(message);
}
