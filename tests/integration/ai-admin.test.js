import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { overrideAiConfigForTests } from '../../src/services/ai/ai.config.js';

const client = api();
let server;
let restoreConfig;

function responseJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startOllama({
  chatContent = null,
  chatDelayMs = 0,
  capabilities = ['completion'],
  chatStatus = 200,
} = {}) {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/api/tags') return responseJson(res, { models: [{ name: 'test:latest' }] });
      if (req.url === '/api/show') {
        return responseJson(res, {
          details: { family: 'granite' },
          ...(capabilities === null ? {} : { capabilities }),
        });
      }
      if (req.url === '/api/chat') {
        if (chatStatus !== 200) return responseJson(res, { error: 'model not found' }, chatStatus);
        const reply = {
          intent: 'OTHER',
          language: 'fr',
          confidence: 0.9,
          needs_human: true,
          reply: 'Le test local fonctionne.',
          reasons: [],
        };
        const content = chatContent ?? JSON.stringify(reply);
        setTimeout(() => responseJson(res, {
          message: { content },
          prompt_eval_count: 12,
          eval_count: 6,
        }), chatDelayMs);
        return;
      }
      responseJson(res, { error: 'unknown endpoint' }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function tokenFor(user) {
  return generateToken({ id: user.id, role: user.roleId });
}

async function adminAuthHeader() {
  const user = await createUser({ role: 'ADMIN' });
  return authHeader(tokenFor(user));
}

afterEach(async () => {
  restoreConfig?.();
  restoreConfig = null;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

describe('API admin IA', () => {
  it('renvoie le statut quand Ollama répond', async () => {
    const baseUrl = await startOllama();
    restoreConfig = overrideAiConfigForTests({ enabled: true, model: 'test:latest', baseUrl });
    const res = await client.get('/api/v2/admin/ai/status').set(await adminAuthHeader());

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      provider: 'ollama',
      reachable: true,
      modelInstalled: true,
      capabilities: ['completion'],
      queue: { pending: 0, running: 0 },
    });
  });

  it('accepte les anciennes réponses /api/show sans capabilities', async () => {
    const baseUrl = await startOllama({ capabilities: null });
    restoreConfig = overrideAiConfigForTests({ enabled: true, model: 'test:latest', baseUrl });
    const res = await client.get('/api/v2/admin/ai/status').set(await adminAuthHeader());

    expect(res.status, res.text).toBe(200);
    expect(res.body.capabilities).toEqual([]);
  });

  it('renvoie reachable=false si Ollama est injoignable', async () => {
    restoreConfig = overrideAiConfigForTests({
      enabled: true,
      model: 'test:latest',
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 100,
    });
    const res = await client.get('/api/v2/admin/ai/status').set(await adminAuthHeader());

    expect(res.status, res.text).toBe(200);
    expect(res.body.reachable).toBe(false);
    expect(res.body.modelInstalled).toBe(false);
  });

  it('teste avec succès une génération structurée', async () => {
    const baseUrl = await startOllama();
    restoreConfig = overrideAiConfigForTests({ enabled: true, model: 'test:latest', baseUrl });
    const res = await client.post('/api/v2/admin/ai/test').set(await adminAuthHeader());

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ ok: true, output: { intent: 'OTHER', needs_human: true } });
    expect(res.body.latencyMs).toEqual(expect.any(Number));
  });

  it('renvoie 409 AI_DISABLED si le moteur est désactivé', async () => {
    restoreConfig = overrideAiConfigForTests({ enabled: false, model: '' });
    const res = await client.post('/api/v2/admin/ai/test').set(await adminAuthHeader()).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AI_DISABLED');
  });

  it('renvoie 502 AI_UNREACHABLE en cas de dépassement du délai', async () => {
    const baseUrl = await startOllama({ chatDelayMs: 100 });
    restoreConfig = overrideAiConfigForTests({ enabled: true, model: 'test:latest', baseUrl, timeoutMs: 20 });
    const res = await client.post('/api/v2/admin/ai/test').set(await adminAuthHeader()).send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_UNREACHABLE');
  });

  it('renvoie 502 AI_INVALID_OUTPUT si le modèle ne renvoie pas du JSON', async () => {
    const baseUrl = await startOllama({ chatContent: '{invalid json' });
    restoreConfig = overrideAiConfigForTests({ enabled: true, model: 'test:latest', baseUrl });
    const res = await client.post('/api/v2/admin/ai/test').set(await adminAuthHeader()).send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_INVALID_OUTPUT');
  });

  it('renvoie 502 AI_MODEL_MISSING si Ollama ne trouve pas le modèle', async () => {
    const baseUrl = await startOllama({ chatStatus: 404 });
    restoreConfig = overrideAiConfigForTests({ enabled: true, model: 'test:missing', baseUrl });
    const res = await client.post('/api/v2/admin/ai/test').set(await adminAuthHeader()).send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_MODEL_MISSING');
  });

  it('refuse un compte non administrateur', async () => {
    const buyer = await createUser({ role: 'BUYER' });
    const res = await client.get('/api/v2/admin/ai/status').set(authHeader(tokenFor(buyer)));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LEVEL_FORBIDDEN');
  });
});
