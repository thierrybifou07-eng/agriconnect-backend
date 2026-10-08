import { describe, it, expect } from 'vitest';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

function tokenFor(user, role) {
  return generateToken({ id: user.id, role });
}

async function buyer() {
  const user = await createUser({ role: 'BUYER' });
  return { user, token: tokenFor(user, 'BUYER') };
}

describe('Le hash de mot de passe ne sort jamais', () => {
  // protect() chargeait l'utilisateur complet, hash compris. Aucun controleur
  // ne renvoyait aujourd'hui req.user tel quel, mais la protection reposait
  // sur la discipline de chacun : un res.json(req.user) suffisait a faire fuiter
  // le hash. Le middleware ne selectionne plus la colonne.
  it('GET /api/v2/auth/me ne renvoie pas le hash', async () => {
    const { token } = await buyer();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });

  it('PATCH /api/v2/auth/me ne renvoie pas le hash', async () => {
    const { token } = await buyer();

    const res = await client.patch('/api/v2/auth/me').set(authHeader(token)).send({ location: 'Rabat' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.password).toBeUndefined();
  });

  it('req.user ne contient pas le hash', async () => {
    const { user } = await buyer();

    const { protect } = await import('../../src/middlewares/auth.middleware.js');
    const req = { headers: { authorization: `Bearer ${tokenFor(user, 'BUYER')}` } };
    let captured;
    req.user = undefined;
    // On rejoue le middleware pour inspecter ce qu il met sur req.
    await new Promise((resolve) => {
      protect(req, { status: () => ({ json: resolve }) }, () => {
        captured = req.user;
        resolve();
      });
    });

    expect(captured).toBeTruthy();
    expect(captured.password).toBeUndefined();
    // Les champs utiles restent presents, sinon le middleware casserait tout.
    expect(captured.id).toBe(user.id);
    expect(captured.role.code).toBe('BUYER');
  });
});