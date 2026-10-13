import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

const Decimal = Prisma.Decimal;

// --- Fixtures ---

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

async function fournisseur() {
  const user = await createUser({ role: 'SUPPLIER' });
  const profile = await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return { user, profile };
}

async function produit() {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: identifiant('Produit'),
      isPerishable: false,
    },
  });
}

async function zone() {
  return prisma.zone.create({ data: { name: identifiant('Zone') } });
}

async function creerLot({ quantity = '10', agreedUnitPrice = '1000.00', fournisseur: f } = {}) {
  const { profile } = f ?? (await fournisseur());
  const product = await produit();
  const zoneTest = await zone();
  return prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId: profile.id,
      productId: product.id,
      zoneId: zoneTest.id,
      agreedUnitPrice,
      quantityInitial: new Decimal(quantity),
      quantityAvailable: new Decimal(quantity),
      storageType: 'SUPPLIER_SITE',
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      status: 'AVAILABLE',
    },
  });
}

async function agentAvecCapacite(capacites) {
  const user = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: user.id, displayName: 'Agent Test', isActive: true },
  });
  for (const code of capacites) {
    const cap = await prisma.agentCapability.findFirst({ where: { code } });
    await prisma.agentCapabilityLink.create({ data: { agentId: agent.id, capabilityId: cap.id } });
  }
  return { user, agent };
}

// Livraison minimale (commande + agence) pour tester le livré optionnel.
async function creerLivraison() {
  const buyer = await createUser({ role: 'BUYER' });
  const mode = await prisma.deliveryMode.findUnique({ where: { code: 'HUB_PICKUP' } });
  const agence = await prisma.transportAgency.create({
    data: { name: identifiant('Agence'), phone: '+33600000000' },
  });
  const commande = await prisma.order.create({
    data: {
      orderNumber: identifiant('CMD'),
      buyerId: buyer.id,
      deliveryModeId: mode.id,
      subtotal: new Decimal(0),
      total: new Decimal(0),
    },
  });
  return prisma.delivery.create({
    data: {
      orderId: commande.id,
      agencyId: agence.id,
      dropoffAddress: '1 rue du marché',
    },
  });
}

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'AGENT', level: 30 } });
}

function tokenAdminPour(user) {
  return generateToken({ id: user.id, role: { code: 'ADMIN', level: 50 } });
}

function tokenFournisseurPour(user) {
  return generateToken({ id: user.id, role: { code: 'SUPPLIER', level: 10 } });
}

// Déclare une perte via l'API staff (agent muni de DISPUTE_HANDLING).
async function declarerPerte({ lot, quantity = 2, reason = 'EXPIRED_UNSOLD', deliveryId = null, note = null }) {
  const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);
  const res = await api()
    .post('/api/v2/staff/compensations')
    .set(authHeader(tokenPour(agentUser)))
    .send({ lotId: lot.id, reason, quantity, ...(deliveryId ? { deliveryId } : {}), ...(note ? { note } : {}) });
  return res;
}

// --- Tests ---

describe('Indemnisation des invendus et pertes (P6.2)', () => {
  // Le taux seedé vaut 1 (100 %) : les tests de calcul fixent le taux
  // explicitement à 50 % et restaurent la valeur d'origine après la suite.
  let TAUX_ORIGINAL = new Decimal(1);
  const TAUX_TEST = new Decimal('0.5');

  beforeAll(async () => {
    const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
    if (settings) {
      TAUX_ORIGINAL = new Decimal(settings.expiryCompensationRate);
    }
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { expiryCompensationRate: TAUX_TEST },
    });
  });

  afterAll(async () => {
    await prisma.platformSetting.update({
      where: { id: 1 },
      data: { expiryCompensationRate: TAUX_ORIGINAL },
    });
  });

  describe('POST /api/v2/staff/compensations', () => {
    it('montant = quantité × prix convenu × taux, arrondi XAF', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });

      const res = await declarerPerte({ lot, quantity: 2.5 });

      expect(res.status, res.text).toBe(201);
      expect(res.body.status).toBe('PENDING_APPROVAL');
      expect(res.body.reason).toBe('EXPIRED_UNSOLD');
      expect(res.body.quantity).toBe(2.5);
      expect(res.body.unitPrice).toBe(1000);
      expect(res.body.rate).toBe(0.5);
      // 2.5 × 1000 × 0.5 = 1250 XAF (arrondi au franc, 0 décimale)
      expect(res.body.amount).toBe(1250);

      // Vérif en base : le taux est figé sur la ligne
      const row = await prisma.supplierCompensation.findUnique({ where: { id: res.body.id } });
      expect(row.amount.toString()).toBe('1250');
      expect(row.rate.toString()).toBe('0.5');
      expect(row.status).toBe('PENDING_APPROVAL');
    });

    it('arrondi XAF : les centimes sont arrondis au plus proche franc', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '333.00' });

      const res = await declarerPerte({ lot, quantity: 2.5 });

      expect(res.status, res.text).toBe(201);
      // 2.5 × 333 × 0.5 = 416,25 -> 416 XAF (ROUND_HALF_UP)
      expect(res.body.amount).toBe(416);
    });

    it('taux 0 : aucune indemnisation créée', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      await prisma.platformSetting.update({
        where: { id: 1 },
        data: { expiryCompensationRate: new Decimal(0) },
      });

      try {
        const res = await declarerPerte({ lot, quantity: 2 });

        expect(res.status, res.text).toBe(200);
        expect(res.body.created).toBe(false);

        // Aucune ligne en base
        const count = await prisma.supplierCompensation.count({ where: { lotId: lot.id } });
        expect(count).toBe(0);
      } finally {
        await prisma.platformSetting.update({
          where: { id: 1 },
          data: { expiryCompensationRate: TAUX_TEST },
        });
      }
    });

    it('quantité > quantité du lot : 400', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });

      const res = await declarerPerte({ lot, quantity: 11 });

      expect(res.status, res.text).toBe(400);
      expect(res.body.code).toBe('INVALID_QUANTITY');
    });

    it('quantité nulle : 400 (Joi refuse avant le service)', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });

      const res = await declarerPerte({ lot, quantity: 0 });

      expect(res.status, res.text).toBe(400);
      // Joi number().positive() refuse zéro : la réponse de validation n'a
      // pas de code, le contrôle du service (INVALID_QUANTITY) est la
      // seconde couche, atteinte seulement si Joi est contourné.
      expect(res.body.error).toBe('Données invalides');
    });

    it('lot introuvable : 404', async () => {
      const res = await api()
        .post('/api/v2/staff/compensations')
        .set(authHeader(tokenPour((await agentAvecCapacite(['DISPUTE_HANDLING'])).user)))
        .send({ lotId: 999999, reason: 'LOST_OR_DAMAGED', quantity: 1 });

      expect(res.status, res.text).toBe(404);
      expect(res.body.code).toBe('LOT_NOT_FOUND');
    });

    it('livraison introuvable : 404', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });

      const res = await declarerPerte({ lot, quantity: 1, deliveryId: 999999 });

      expect(res.status, res.text).toBe(404);
      expect(res.body.code).toBe('DELIVERY_NOT_FOUND');
    });

    it('avec deliveryId valide : la livraison est tracée', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const livraison = await creerLivraison();

      const res = await declarerPerte({ lot, quantity: 1, deliveryId: livraison.id });

      expect(res.status, res.text).toBe(201);
      expect(res.body.deliveryId).toBe(livraison.id);
    });

    it('note optionnelle : enregistrée puis relue par le fournisseur', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });

      const res = await declarerPerte({ lot, quantity: 1, note: 'Casse constatée à la livraison' });

      expect(res.status, res.text).toBe(201);
      expect(res.body.note).toBe('Casse constatée à la livraison');
    });

    it('un AGENT sans capacité est refusé : 403', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      const res = await api()
        .post('/api/v2/staff/compensations')
        .set(authHeader(tokenPour(agentUser)))
        .send({ lotId: lot.id, reason: 'EXPIRED_UNSOLD', quantity: 1 });

      expect(res.status, res.text).toBe(403);
    });

    it('un fournisseur ne peut pas déclarer : 403', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });

      const res = await api()
        .post('/api/v2/staff/compensations')
        .set(authHeader(tokenFournisseurPour(f.user)))
        .send({ lotId: lot.id, reason: 'EXPIRED_UNSOLD', quantity: 1 });

      expect(res.status, res.text).toBe(403);
    });

    it('un ADMIN est toujours autorisé : 201', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .post('/api/v2/staff/compensations')
        .set(authHeader(tokenAdminPour(admin)))
        .send({ lotId: lot.id, reason: 'LOST_OR_DAMAGED', quantity: 1 });

      expect(res.status, res.text).toBe(201);
      expect(res.body.status).toBe('PENDING_APPROVAL');
    });
  });

  describe('Cycle de vie admin', () => {
    async function preparerCompensation() {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const res = await declarerPerte({ lot, quantity: 2 });
      expect(res.status, res.text).toBe(201);
      const admin = await createUser({ role: 'ADMIN' });
      return { lot, compensation: res.body, admin };
    }

    it('cycle complet : création → approbation → paiement avec audit', async () => {
      const { compensation, admin } = await preparerCompensation();

      // Approbation
      let res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(authHeader(tokenAdminPour(admin)));
      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.approvedById).toBe(admin.id);
      expect(res.body.approvedAt).toBeTruthy();

      // Paiement
      res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ reference: identifiant('VIR') });
      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('PAID');
      expect(res.body.paidAt).toBeTruthy();

      // Vérif en base
      const row = await prisma.supplierCompensation.findUnique({ where: { id: compensation.id } });
      expect(row.status).toBe('PAID');
      expect(row.paidById).toBeUndefined(); // pas de colonne paidById : l'acteur est dans l'audit
      expect(row.paidAt).toBeTruthy();

      // Audit : une ligne par action, la référence du virement dans le paiement
      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'SupplierCompensation', entityId: compensation.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((a) => a.action)).toEqual([
        'COMPENSATION_CREATED',
        'COMPENSATION_APPROVED',
        'COMPENSATION_PAID',
      ]);
      const paiement = audits.find((a) => a.action === 'COMPENSATION_PAID');
      expect(paiement.metadata.reference).toBeTruthy();
    });

    it('paiement d une indemnisation non approuvée : 409', async () => {
      const { compensation, admin } = await preparerCompensation();

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('double approbation : 409', async () => {
      const { compensation, admin } = await preparerCompensation();

      let res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(authHeader(tokenAdminPour(admin)));
      expect(res.status, res.text).toBe(200);

      res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(authHeader(tokenAdminPour(admin)));
      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('rejet : PENDING_APPROVAL -> REJECTED, la note de rejet remplace la note initiale', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const cree = await declarerPerte({ lot, quantity: 1, note: 'motif initial' });
      expect(cree.status, cree.text).toBe(201);
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .patch(`/api/v2/admin/compensations/${cree.body.id}/reject`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ note: 'Perte non documentée' });

      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('REJECTED');
      expect(res.body.note).toBe('Perte non documentée');

      const row = await prisma.supplierCompensation.findUnique({ where: { id: cree.body.id } });
      expect(row.status).toBe('REJECTED');
      expect(row.note).toBe('Perte non documentée');

      // Audit du rejet
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'COMPENSATION_REJECTED', entityType: 'SupplierCompensation', entityId: cree.body.id },
      });
      expect(audit).toBeTruthy();
    });

    it('approbation après rejet : 409', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const cree = await declarerPerte({ lot, quantity: 1 });
      const admin = await createUser({ role: 'ADMIN' });

      let res = await api()
        .patch(`/api/v2/admin/compensations/${cree.body.id}/reject`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ note: 'rejet' });
      expect(res.status, res.text).toBe(200);

      res = await api()
        .patch(`/api/v2/admin/compensations/${cree.body.id}/approve`)
        .set(authHeader(tokenAdminPour(admin)));
      expect(res.status, res.text).toBe(409);
    });

    it('paiement après rejet : 409', async () => {
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const cree = await declarerPerte({ lot, quantity: 1 });
      const admin = await createUser({ role: 'ADMIN' });

      await api()
        .patch(`/api/v2/admin/compensations/${cree.body.id}/reject`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ note: 'rejet' });

      const res = await api()
        .patch(`/api/v2/admin/compensations/${cree.body.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ reference: identifiant('VIR') });
      expect(res.status, res.text).toBe(409);
    });

    it('rejet sans note : 400', async () => {
      const { compensation, admin } = await preparerCompensation();

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/reject`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({});

      expect(res.status, res.text).toBe(400);
    });

    it('paiement sans reference : 400', async () => {
      const { compensation, admin } = await preparerCompensation();

      await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(authHeader(tokenAdminPour(admin)));

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({});

      expect(res.status, res.text).toBe(400);
    });

    it('indemnisation introuvable : 404', async () => {
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .patch('/api/v2/admin/compensations/999999/approve')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status, res.text).toBe(404);
      expect(res.body.code).toBe('COMPENSATION_NOT_FOUND');
    });

    it('un AGENT (niveau 30) est refusé : 403', async () => {
      const { compensation } = await preparerCompensation();
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(authHeader(tokenPour(agentUser)));

      expect(res.status, res.text).toBe(403);
    });

    it('un agent IA est refusé : 403 (requireHumanActor)', async () => {
      const { compensation } = await preparerCompensation();
      const user = await createUser({ role: 'AGENT' });
      await prisma.agent.create({
        data: { kind: 'AI', userId: user.id, displayName: 'IA Test', isActive: true },
      });

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(authHeader(tokenPour(user)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(403);
    });

    it('liste admin : toutes les indemnisations avec identité fournisseur', async () => {
      const { compensation } = await preparerCompensation();
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .get('/api/v2/admin/compensations')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status, res.text).toBe(200);
      const item = res.body.items.find((c) => c.id === compensation.id);
      expect(item).toBeTruthy();
      expect(item.amount).toBe(1000);
      expect(item.supplier).toBeTruthy();
      expect(item.supplier.farmName).toBe('Ferme du Test');
    });

    it('filtre par statut', async () => {
      const { compensation, admin } = await preparerCompensation();

      // Une seconde indemnisation approuvée pour distinguer les deux statuts
      const lot2 = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00' });
      const cree2 = await declarerPerte({ lot: lot2, quantity: 1 });
      await api()
        .patch(`/api/v2/admin/compensations/${cree2.body.id}/approve`)
        .set(authHeader(tokenAdminPour(admin)));

      const res = await api()
        .get('/api/v2/admin/compensations?status=PENDING_APPROVAL')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.items.every((c) => c.status === 'PENDING_APPROVAL')).toBe(true);
      expect(res.body.items.find((c) => c.id === compensation.id)).toBeTruthy();
    });
  });

  describe('GET /api/v2/supplier/compensations', () => {
    it('un fournisseur ne voit que les siennes', async () => {
      const f1 = await fournisseur();
      const f2 = await fournisseur();
      const lot1 = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f1 });
      const lot2 = await creerLot({ quantity: '10', agreedUnitPrice: '800.00', fournisseur: f2 });

      const c1 = await declarerPerte({ lot: lot1, quantity: 2 });
      const c2 = await declarerPerte({ lot: lot2, quantity: 2 });
      expect(c1.status, c1.text).toBe(201);
      expect(c2.status, c2.text).toBe(201);

      // Chacun ne voit que la sienne
      const res1 = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenFournisseurPour(f1.user)));
      expect(res1.status, res1.text).toBe(200);
      expect(res1.body.items).toHaveLength(1);
      expect(res1.body.items[0].id).toBe(c1.body.id);
      expect(res1.body.items[0].amount).toBe(1000); // 2 × 1000 × 0.5

      const res2 = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenFournisseurPour(f2.user)));
      expect(res2.status, res2.text).toBe(200);
      expect(res2.body.items).toHaveLength(1);
      expect(res2.body.items[0].id).toBe(c2.body.id);
      expect(res2.body.items[0].amount).toBe(800); // 2 × 800 × 0.5
    });

    it('le DTO expose motif, quantité, montant, statut', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '10', agreedUnitPrice: '1000.00', fournisseur: f });
      await declarerPerte({ lot, quantity: 1, reason: 'LOST_OR_DAMAGED' });

      const res = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenFournisseurPour(f.user)));

      expect(res.status, res.text).toBe(200);
      const item = res.body.items[0];
      expect(item.reason).toBe('LOST_OR_DAMAGED');
      expect(item.quantity).toBe(1);
      expect(item.amount).toBe(500); // 1 × 1000 × 0.5
      expect(item.status).toBe('PENDING_APPROVAL');
    });

    it('un admin ne peut pas lister côté fournisseur : 403', async () => {
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status, res.text).toBe(403);
    });
  });
});
