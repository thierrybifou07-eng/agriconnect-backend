import { describe, it, expect } from 'vitest';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// B1 : les controleurs selectionnaient un champ "fullName" sur le modele User,
// qui n existe pas dans le schema. Prisma leve alors une
// PrismaClientValidationError et l API repond 500.
//
// Le cas listings etait le plus visible ; cette lecture admin verrouille qu un
// controleur aligne sur firstname/lastname ne reintroduit pas de champ
// inexistant sur une route qui reste en service.

const client = api();

describe('B1 - GET /api/v2/admin/users ne doit pas casser sur un select inexistant', () => {
  it('renvoie 200 pour un administrateur', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const token = generateToken({ id: admin.id, role: 'ADMIN' });

    const res = await client.get('/api/v2/admin/users').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
  });
});
