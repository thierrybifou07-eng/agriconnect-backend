import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// B1 ne se limitait pas aux `select` : createAdmin et updateMe tentaient
// d'ecrire une colonne `fullName` inexistante. Ces tests le verifient a
// l'execution, la ou un controle statique des cles de select ne voit rien.

const client = api();

async function rootToken() {
  const root = await createUser({ role: 'ROOT' });
  return { root, token: generateToken({ id: root.id, role: 'ROOT' }) };
}

async function buyerToken() {
  const buyer = await createUser({ role: 'BUYER' });
  return { buyer, token: generateToken({ id: buyer.id, role: 'BUYER' }) };
}

describe('POST /api/admin/users - creation d un administrateur', () => {
  it('cree le compte avec prenom et nom', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/admin/users').set(authHeader(token)).send({
      firstname: 'Youssef',
      lastname: 'El Amrani',
      phone: '+33612345678',
      email: 'youssef@example.com',
      password: 'MotDePasse1!',
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ firstname: 'Youssef', lastname: 'El Amrani' });

    const enBase = await prisma.user.findUnique({ where: { email: 'youssef@example.com' } });
    expect(enBase).toBeTruthy();
  });

  it('n expose jamais le hash du mot de passe', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/admin/users').set(authHeader(token)).send({
      firstname: 'Yasmine',
      lastname: 'Tazi',
      phone: '+33612345679',
      email: 'yasmine@example.com',
      password: 'MotDePasse1!',
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.password).toBeUndefined();
  });

  it('refuse un prenom ou un nom manquant', async () => {
    const { token } = await rootToken();

    for (const payload of [
      { lastname: 'Tazi', phone: '+33612345680', password: 'MotDePasse1!' },
      { firstname: 'Yasmine', phone: '+33612345681', password: 'MotDePasse1!' },
    ]) {
      const res = await client.post('/api/admin/users').set(authHeader(token)).send(payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  // La creation d'un administrateur est la privilege le plus eleve de l'API :
  // un roles moins eleve ne doit pas y acceder.
  it('refuse un roles non ROOT', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const token = generateToken({ id: admin.id, role: 'ADMIN' });

    const res = await client.post('/api/admin/users').set(authHeader(token)).send({
      firstname: 'Pirate',
      lastname: 'Intrus',
      phone: '+33612345682',
      password: 'MotDePasse1!',
    });

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/me - mise a jour du profil', () => {
  it('met a jour le prenom et le nom', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .patch('/api/users/me')
      .set(authHeader(token))
      .send({ firstname: 'Amina', lastname: 'Benali' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ firstname: 'Amina', lastname: 'Benali' });
  });

  // Les deux moities sont traitees separement : mettre a jour l'une ne doit
  // jamais effacer l'autre.
  it('ne modifie que le champ envoye', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({ where: { id: buyer.id }, data: { firstname: 'Fatima', lastname: 'Zahra' } });

    await client.patch('/api/users/me').set(authHeader(token)).send({ lastname: 'Alaoui' });

    const enBase = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(enBase.firstname).toBe('Fatima');
    expect(enBase.lastname).toBe('Alaoui');
  });

  it('met a jour la localisation et l email', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .patch('/api/users/me')
      .set(authHeader(token))
      .send({ location: 'Salé', email: 'nouveau@example.com' });

    expect(res.status, res.text).toBe(200);
    const enBase = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(enBase.location).toBe('Salé');
    expect(enBase.email).toBe('nouveau@example.com');
  });

  // Un corps vide ne doit rien changer, et surtout pas tout effacer.
  it('accepte une mise a jour vide sans rien modifier', async () => {
    const { buyer, token } = await buyerToken();
    const avant = await prisma.user.findUnique({ where: { id: buyer.id } });

    const res = await client.patch('/api/users/me').set(authHeader(token)).send({});

    expect(res.status, res.text).toBe(200);
    const apres = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(apres.firstname).toBe(avant.firstname);
    expect(apres.lastname).toBe(avant.lastname);
  });

  it('refuse une mise a jour sans authentification', async () => {
    const res = await client.patch('/api/users/me').send({ firstname: 'Intrus' });
    expect(res.status).toBe(401);
  });
});