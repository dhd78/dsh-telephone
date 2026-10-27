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
export const inject = ['tools', 'sessionController', 'webServer', 'agents'];

const PROMPT = [
  '## Telephone',
  'You can call another resident with `phone_call({ to, note, line? })`. The `note` is at most 100 characters: say who you are, which letter in the other resident\'s mailbox to read, and when to call back. Task details, code, and files belong in the mailbox letter, never in the call.',
  'Use `phone_list` first to see the owner-drawn lines, the resident aliases, whether a line is already active, and your remaining new-line creation quota. When replying on an existing call, pass its `line` id back. A busy resident receives the call at its next turn; a cold resident is resumed. Use `phone_hangup` when the task is done; a line also hangs up after 60 minutes with no call.',
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

  info(ctx, 'telephone ready (owner-drawn lines, per-session quota, 100-char calls)');
}

function info(ctx, message) {
  if (typeof ctx.logger?.info === 'function') ctx.logger.info(message);
}
