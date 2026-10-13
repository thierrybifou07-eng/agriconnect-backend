import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { getLookupId } from '../../src/utils/lookupCache.js';

// B5 : Express donne toujours req.params sous forme de chaine, alors que toutes
// les cles primaires du schema sont des Int. Les lectures
// `where: { id: req.params.id }` du projet repondaient donc 500
// "Argument `id`: Invalid value provided. Expected Int, provided String".
//
// Concretement, tout ce qui passe par une URL parametree etait mort :
// suspension et reactivation d un compte, detail d une session.
//
// Ces tests couvrent la famille de routes entiere, pour que le cas ne puisse
// pas revenir par un seul oubli.

const client = api();

async function adminToken() {
  const admin = await createUser({ role: 'ADMIN' });
  return { admin, token: generateToken({ id: admin.id, role: 'ADMIN' }) };
}

describe('Routes /api/v2/admin/*/:id', () => {
  it('PATCH /users/:id/suspend suspend un compte', async () => {
    const { token } = await adminToken();
    const cible = await createUser({ role: 'BUYER' });

    const res = await client
      .patch(`/api/v2/admin/users/${cible.id}/suspend`)
      .set(authHeader(token));

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.user.findUnique({
      where: { id: cible.id },
      include: { userStatus: true },
    });
    expect(apres.userStatus.code).toBe('SUSPENDED');
  });

  it('PATCH /users/:id/reactivate reactive un compte', async () => {
    const { token } = await adminToken();
    const cible = await createUser({ role: 'BUYER' });
    const suspendu = await getLookupId('userStatus', 'SUSPENDED');
    await prisma.user.update({ where: { id: cible.id }, data: { userStatusId: suspendu } });

    const res = await client
      .patch(`/api/v2/admin/users/${cible.id}/reactivate`)
      .set(authHeader(token));

    expect(res.status, res.text).toBe(200);

    const apres = await prisma.user.findUnique({
      where: { id: cible.id },
      include: { userStatus: true },
    });
    expect(apres.userStatus.code).toBe('ACTIVE');
  });
});
