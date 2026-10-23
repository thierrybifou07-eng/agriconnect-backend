import { describe, expect, it } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const client = api();

async function createAgent({ isActive = true, capabilities = [] } = {}) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { userId: user.id, displayName: 'Agent mobile', kind: 'HUMAN', isActive },
  });
  const rows = await prisma.agentCapability.findMany({
    where: { code: { in: capabilities } },
    select: { id: true },
  });
  await prisma.agentCapabilityLink.createMany({
    data: rows.map(({ id }) => ({ agentId: agent.id, capabilityId: id })),
  });
  return { user, agent };
}

describe('Contrat agent de /auth/me et /auth/login', () => {
  it('expose la fiche active avec les codes de capacité triés', async () => {
    const { user, agent } = await createAgent({
      capabilities: ['SUPPLIER_SUPPORT', 'BUYER_SUPPORT'],
    });
    const token = generateToken({ id: user.id, role: 'AGENT' });

    const me = await client.get('/api/v2/auth/me').set(authHeader(token));
    expect(me.status, me.text).toBe(200);
    expect(me.body.agent).toEqual({
      id: agent.id,
      displayName: 'Agent mobile',
      kind: 'HUMAN',
      autonomy: null,
      capabilities: ['BUYER_SUPPORT', 'SUPPLIER_SUPPORT'],
    });

    const login = await client.post('/api/v2/auth/login').send({
      email: user.email,
      password: 'MotDePasse1!',
    });
    expect(login.status, login.text).toBe(200);
    expect(login.body.user.agent).toEqual(me.body.agent);
  });

  it('renvoie agent null pour une fiche désactivée', async () => {
    const { user } = await createAgent({ isActive: false, capabilities: ['BUYER_SUPPORT'] });
    const token = generateToken({ id: user.id, role: 'AGENT' });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.agent).toBeNull();
  });

  it('renvoie agent null pour un fournisseur', async () => {
    const user = await createUser({ role: 'SUPPLIER' });
    const token = generateToken({ id: user.id, role: 'SUPPLIER' });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.agent).toBeNull();
  });
});
