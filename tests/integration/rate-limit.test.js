import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// L'anti-brute-force est neutralise par defaut en test (voir
// rateLimit.middleware.js), sinon la suite entière se auto-bloquerait. Ce fichier
// le reactive le temps de ses propres cas et vérifie donc qu'il fonctionne
// vraiment, plutôt que de laisser la protection anti-brute-force non testée.

const saved = {
  active: process.env.AUTH_RATE_LIMIT_ACTIVE,
  limit: process.env.AUTH_RATE_LIMIT,
};

afterEach(() => {
  if (saved.active === undefined) delete process.env.AUTH_RATE_LIMIT_ACTIVE;
  else process.env.AUTH_RATE_LIMIT_ACTIVE = saved.active;

  if (saved.limit === undefined) delete process.env.AUTH_RATE_LIMIT;
  else process.env.AUTH_RATE_LIMIT = saved.limit;

  vi.resetModules();
});

// Construit une app minimale portant le middleware, rechargee avec la
// configuration courante. On ne peut pas reutiliser src/app.js : ses routes
// ont capture l'instance du limiteur au moment de l'import.
async function buildApp({ active, limit }) {
  if (active) process.env.AUTH_RATE_LIMIT_ACTIVE = '1';
  else delete process.env.AUTH_RATE_LIMIT_ACTIVE;

  if (limit === undefined) delete process.env.AUTH_RATE_LIMIT;
  else process.env.AUTH_RATE_LIMIT = String(limit);

  vi.resetModules();

  const { authLimiter } = await import('../../src/middlewares/rateLimit.middleware.js');
  const app = express();
  app.get('/ping', authLimiter, (req, res) => res.json({ ok: true }));
  return request(app);
}

describe('Limite anti-brute-force', () => {
  it('laisse passer les requetes sous la limite', async () => {
    const client = await buildApp({ active: true, limit: 3 });

    for (let i = 0; i < 3; i += 1) {
      const res = await client.get('/ping');
      expect(res.status, `requete ${i + 1}`).toBe(200);
    }
  });

  it('bloque avec 429 au-dela de la limite', async () => {
    const client = await buildApp({ active: true, limit: 3 });

    await client.get('/ping');
    await client.get('/ping');
    await client.get('/ping');

    const res = await client.get('/ping');

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/trop de tentatives/i);
  });

  // Sans cet en-tete, un client ne peut pas savoir quand reessayer.
  it('expose le quota restant', async () => {
    const client = await buildApp({ active: true, limit: 3 });

    const res = await client.get('/ping');

    expect(res.headers['ratelimit-limit']).toBe('3');
    expect(res.headers['ratelimit-remaining']).toBe('2');
  });

  it('reste inactif en test tant qu on ne le demande pas', async () => {
    delete process.env.AUTH_RATE_LIMIT_ACTIVE;
    process.env.AUTH_RATE_LIMIT = '2';
    vi.resetModules();

    const client = await buildApp({ active: false, limit: 2 });

    // Bien au-dela de la limite configuree : rien ne doit bloquer, sinon la
    // suite s'auto-bloquerait toute seule.
    for (let i = 0; i < 6; i += 1) {
      const res = await client.get('/ping');
      expect(res.status, `requete ${i + 1}`).toBe(200);
    }
  });

  it("s'applique en production avec la limite stricte par defaut", async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_RATE_LIMIT_ACTIVE;
    delete process.env.AUTH_RATE_LIMIT;

    try {
      vi.resetModules();
      const { authLimiter } = await import('../../src/middlewares/rateLimit.middleware.js');
      const app = express();
      app.get('/ping', authLimiter, (req, res) => res.json({ ok: true }));
      const client = request(app);

      // La valeur codee en dur en production est 10 : la 11e requete doit
      // etre rejetee. C'est ce qui protege le login contre le brute-force.
      for (let i = 0; i < 10; i += 1) {
        const res = await client.get('/ping');
        expect(res.status, `requete ${i + 1}`).toBe(200);
      }
      const res = await client.get('/ping');
      expect(res.status).toBe(429);
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });
});
