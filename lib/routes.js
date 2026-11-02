/**
 * Plugin-page routes. These are owner actions:
 *   - draw/remove phonebook lines and set each line's max rounds;
 *   - assign each Session's new-line creation quota;
 *   - hang up a line;
 *   - read the switchboard snapshot.
 *
 * The agent never gets these routes; quota allocation is deliberately user-only.
 */

const API = '/api/telephone-v10';
const MAX_BODY = 64 * 1024;

import { spawn } from 'node:child_process';

export function registerPhoneRoutes(ctx, phone, logger = console) {
  const register = (path, handler) => {
    try {
      ctx.webServer.register({ kind: 'exact', path, handler });
    } catch (error) {
      const message = error && error.message ? String(error.message) : '';
      if (!message.includes('duplicate exact route')) throw error;
      logger.warn?.(`telephone: route already registered: ${path}`);
    }
  };

  register(`${API}/state`, async (request, response) => {
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      return sendJson(response, 200, await phone.snapshot());
    } catch (error) {
      return sendJson(response, 500, errorPayload(error));
    }
  });

  register(`${API}/roster`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      return sendJson(response, 200, await phone.saveRoster(payload.entries));
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/roster/remove`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      return sendJson(response, 200, await phone.removeFromRoster(payload.sessionId));
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/links`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      return sendJson(response, 200, await phone.saveLinks(payload.links));
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/quota`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      return sendJson(response, 200, await phone.setQuota(payload.sessionId, payload.quota, payload.unlimited));
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/settings`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      if (typeof payload.allowColdResume === 'boolean') await phone.setAllowColdResume(payload.allowColdResume);
      if (payload.defaultDelivery !== undefined) await phone.setDefaultDelivery(payload.defaultDelivery);
      if (payload.defaultPriority !== undefined) await phone.setDefaultPriority(payload.defaultPriority);
      if (typeof payload.allowUrgentThroughDnd === 'boolean') await phone.setUrgentThroughDnd(payload.allowUrgentThroughDnd);
      if (payload.maxCallsPerHour !== undefined) await phone.setMaxCallsPerHour(payload.maxCallsPerHour);
      if (payload.quietHours !== undefined) await phone.setQuietHours(payload.quietHours);
      return sendJson(response, 200, await phone.snapshot());
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/dnd`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      return sendJson(response, 200, await phone.setDnd(payload.sessionId, payload.dnd));
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/mailbox/open`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      const path = phone.mailboxPathFor(payload.mailboxId);
      await openFolder(path);
      return sendJson(response, 200, { ok: true, path });
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });

  register(`${API}/hangup`, async (request, response) => {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const payload = await readJson(request);
      const result = await phone.hangupLine(payload.lineId, { id: 'owner-page' });
      return sendJson(response, 200, { ...result, state: await phone.snapshot() });
    } catch (error) {
      return sendJson(response, 400, errorPayload(error));
    }
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error('body-too-large'));
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

function errorPayload(error) {
  return {
    ok: false,
    error: typeof error?.code === 'string' ? error.code : 'telephone-failed',
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

async function openFolder(path) {
  // Only paths already validated by phone.mailboxPathFor reach this function.
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  await new Promise((resolvePromise) => {
    child.once('spawn', resolvePromise);
    child.once('error', resolvePromise);
  });
}
