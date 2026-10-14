import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

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

async function creerLot({ quantity = '100', agreedUnitPrice = '1000.00', fournisseur: f } = {}) {
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

function tokenPour(user) {
  return generateToken({ id: user.id, role: { code: 'AGENT', level: 30 } });
}

function tokenAdminPour(user) {
  return generateToken({ id: user.id, role: { code: 'ADMIN', level: 50 } });
}

function tokenFournisseurPour(user) {
  return generateToken({ id: user.id, role: { code: 'SUPPLIER', level: 20 } });
}

async function demanderIndemnisation(lotId, quantity = 10, token) {
  return api()
    .post('/api/v2/staff/compensations')
    .set(authHeader(token))
    .send({ lotId, reason: 'EXPIRED_UNSOLD', quantity, note: 'Invendus périmés' });
}

// --- Tests ---

describe('Indemnisations fournisseurs (P6.2)', () => {
  // Le taux seedé vaut 1 : les tests de montant auraient un cas dégénéré
  // (montant = quantité x prix). On fixe un taux avec décimales pour vérifier
  // l'arrondi XAF, et on restaure la valeur d'origine après la suite.
  let TAUX_ORIGINAL = new Decimal(1);
  const TAUX_TEST = new Decimal('0.3333');

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
    it('montant = quantité x prix convenu x taux, arrondi XAF, taux figé', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '1000.50', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));
      expect(res.status, res.text).toBe(201);

      // 10 x 1000.50 x 0.3333 = 3334,6665 -> 3335 XAF (arrondi half-up)
      expect(res.body.amount.toString()).toBe('3335');
      expect(res.body.quantity.toString()).toBe('10');
      expect(res.body.unitPrice.toString()).toBe('1000.5');
      // Le taux est figé sur la ligne au moment de la création
      expect(res.body.rate.toString()).toBe('0.3333');
      expect(res.body.status).toBe('PENDING_APPROVAL');
      expect(res.body.reason).toBe('EXPIRED_UNSOLD');

      // Vérif en base : la ligne appartient bien au fournisseur du lot
      const enBase = await prisma.supplierCompensation.findUnique({ where: { id: res.body.id } });
      expect(enBase.supplierId).toBe(f.profile.id);
      expect(enBase.lotId).toBe(lot.id);

      // Audit COMPENSATION_CREATED
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'COMPENSATION_CREATED', entityType: 'SupplierCompensation', entityId: res.body.id },
      });
      expect(audit).toBeTruthy();

      // Un changement de taux ultérieur ne remet pas en cause la ligne créée
      await prisma.platformSetting.update({
        where: { id: 1 },
        data: { expiryCompensationRate: new Decimal('0.5') },
      });
      const apres = await prisma.supplierCompensation.findUnique({ where: { id: res.body.id } });
      expect(apres.rate.toString()).toBe('0.3333');
      expect(apres.amount.toString()).toBe('3335');
      // Restaure le taux de la suite du describe
      await prisma.platformSetting.update({
        where: { id: 1 },
        data: { expiryCompensationRate: TAUX_TEST },
      });
    });

    it('quantité > quantité du lot -> 400', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '1000.00', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await demanderIndemnisation(lot.id, 101, tokenPour(agentUser));
      expect(res.status, res.text).toBe(400);
      expect(res.body.code).toBe('QUANTITY_EXCEEDS_LOT');
      expect(await prisma.supplierCompensation.count()).toBe(0);
    });

    it('lot introuvable -> 404', async () => {
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);
      const res = await demanderIndemnisation(99999999, 10, tokenPour(agentUser));
      expect(res.status, res.text).toBe(404);
    });

    it('livraison inconnue -> 400', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await api()
        .post('/api/v2/staff/compensations')
        .set(authHeader(tokenPour(agentUser)))
        .send({ lotId: lot.id, reason: 'LOST_OR_DAMAGED', quantity: 10, deliveryId: 99999999 });
      expect(res.status, res.text).toBe(400);
    });

    it('raison invalide -> 400', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await api()
        .post('/api/v2/staff/compensations')
        .set(authHeader(tokenPour(agentUser)))
        .send({ lotId: lot.id, reason: 'VOLONTAIRE', quantity: 10 });
      expect(res.status, res.text).toBe(400);
    });

    it('un AGENT sans capacité DISPUTE_HANDLING est refusé : 403', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      const res = await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));
      expect(res.status, res.text).toBe(403);
    });

    it('un ADMIN peut créer (court-circuit de capacité, level >= 50)', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '500.00', fournisseur: f });
      const admin = await createUser({ role: 'ADMIN' });

      const res = await demanderIndemnisation(lot.id, 10, tokenAdminPour(admin));
      expect(res.status, res.text).toBe(201);
      expect(res.body.status).toBe('PENDING_APPROVAL');
    });

    it('taux à zéro : aucune indemnisation créée -> 400', async () => {
      await prisma.platformSetting.update({
        where: { id: 1 },
        data: { expiryCompensationRate: new Decimal(0) },
      });

      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));
      expect(res.status, res.text).toBe(400);
      expect(res.body.code).toBe('COMPENSATION_RATE_ZERO');
      expect(await prisma.supplierCompensation.count()).toBe(0);

      // Restaure le taux de la suite : les tests suivants tournent après celui-ci
      await prisma.platformSetting.update({
        where: { id: 1 },
        data: { expiryCompensationRate: TAUX_TEST },
      });
    });
  });

  describe('Cycle complet : approbation puis paiement', () => {
    async function preparerEnAttente() {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '1000.00', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const res = await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));
      expect(res.status, res.text).toBe(201);
      return { compensation: res.body };
    }

    it('création -> approbation -> paiement, avec audit et paidById', async () => {
      const { compensation } = await preparerEnAttente();
      const admin = await createUser({ role: 'ADMIN' });
      const token = authHeader(tokenAdminPour(admin));

      // Approbation : PENDING_APPROVAL -> APPROVED
      let res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(token);
      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.approvedById).toBe(admin.id);
      expect(res.body.approvedAt).toBeTruthy();

      // Paiement : APPROVED -> PAID
      res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(token)
        .send({ reference: identifiant('VIR') });
      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('PAID');
      expect(res.body.paidById).toBe(admin.id);
      expect(res.body.paidAt).toBeTruthy();
      expect(res.body.reference).toBeTruthy();

      // Vérif en base : reference, paidAt ET paidById écrits sur la ligne
      const enBase = await prisma.supplierCompensation.findUnique({ where: { id: compensation.id } });
      expect(enBase.status).toBe('PAID');
      expect(enBase.reference).toBeTruthy();
      expect(enBase.paidAt).toBeTruthy();
      expect(enBase.paidById).toBe(admin.id);

      // Audits COMPENSATION_APPROVED puis COMPENSATION_PAID
      const approbation = await prisma.auditLog.findFirst({
        where: { action: 'COMPENSATION_APPROVED', entityType: 'SupplierCompensation', entityId: compensation.id },
      });
      expect(approbation).toBeTruthy();
      const paiement = await prisma.auditLog.findFirst({
        where: { action: 'COMPENSATION_PAID', entityType: 'SupplierCompensation', entityId: compensation.id },
      });
      expect(paiement).toBeTruthy();
    });

    it('paiement d une indemnisation non approuvée -> 409', async () => {
      const { compensation } = await preparerEnAttente();
      const admin = await createUser({ role: 'ADMIN' });

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(authHeader(tokenAdminPour(admin)))
        .send({ reference: identifiant('VIR') });

      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('rejet : PENDING_APPROVAL -> REJECTED, puis approve -> 409', async () => {
      const { compensation } = await preparerEnAttente();
      const admin = await createUser({ role: 'ADMIN' });
      const token = authHeader(tokenAdminPour(admin));

      let res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/reject`)
        .set(token)
        .send({ note: 'Justificatif manquant' });
      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('REJECTED');
      expect(res.body.note).toBe('Justificatif manquant');

      // REJECTED est terminal : plus aucune transition possible
      res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(token);
      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('approuver deux fois -> 409 (APPROVED n accepte que PAID)', async () => {
      const { compensation } = await preparerEnAttente();
      const admin = await createUser({ role: 'ADMIN' });
      const token = authHeader(tokenAdminPour(admin));

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(token);
      expect(res.status, res.text).toBe(200);

      const bis = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(token);
      expect(bis.status, bis.text).toBe(409);
    });

    it('paiement sans reference -> 400 ; référence trop longue -> 400', async () => {
      const { compensation } = await preparerEnAttente();
      const admin = await createUser({ role: 'ADMIN' });
      const token = authHeader(tokenAdminPour(admin));

      await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(token)
        .expect(200);

      let res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(token)
        .send({});
      expect(res.status, res.text).toBe(400);

      res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
        .set(token)
        .send({ reference: 'x'.repeat(101) });
      expect(res.status, res.text).toBe(400);
    });

    it('deux paiements simultanés -> un 200 et un 409, un seul audit', async () => {
      const { compensation } = await preparerEnAttente();
      const admin = await createUser({ role: 'ADMIN' });
      const token = authHeader(tokenAdminPour(admin));

      await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(token)
        .expect(200);

      const [res1, res2] = await Promise.all([
        api()
          .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
          .set(token)
          .send({ reference: 'VIR-A' }),
        api()
          .patch(`/api/v2/admin/compensations/${compensation.id}/pay`)
          .set(token)
          .send({ reference: 'VIR-B' }),
      ]);

      expect([res1.status, res2.status].sort()).toEqual([200, 409]);

      const enBase = await prisma.supplierCompensation.findUnique({ where: { id: compensation.id } });
      expect(enBase.status).toBe('PAID');
      expect(['VIR-A', 'VIR-B']).toContain(enBase.reference);
      expect(enBase.paidById).toBe(admin.id);

      const audits = await prisma.auditLog.findMany({
        where: { action: 'COMPENSATION_PAID', entityType: 'SupplierCompensation', entityId: compensation.id },
      });
      expect(audits).toHaveLength(1);
    });

    it('un AGENT (niveau 30) est refusé sur les routes admin : 403', async () => {
      const { compensation } = await preparerEnAttente();
      const { user: agentUser } = await agentAvecCapacite(['ORDER_PROCESSING']);

      const res = await api()
        .patch(`/api/v2/admin/compensations/${compensation.id}/approve`)
        .set(authHeader(tokenPour(agentUser)));
      expect(res.status, res.text).toBe(403);
    });
  });

  describe('GET /api/v2/admin/compensations', () => {
    it('vue admin complète : fournisseur et compte de paiement par défaut', async () => {
      const f = await fournisseur();
      // Compte de paiement par défaut : l'admin a besoin du numéro complet
      // pour effectuer le virement (comme la vue admin des reversements).
      await prisma.payoutAccount.create({
        data: {
          userId: f.user.id,
          method: 'BANK_TRANSFER',
          provider: 'Banque Test',
          accountNumber: '01234567890',
          accountName: 'Ferme du Test',
          isDefault: true,
        },
      });
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '1000.00', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const creation = await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));
      expect(creation.status, creation.text).toBe(201);

      const admin = await createUser({ role: 'ADMIN' });
      const res = await api()
        .get('/api/v2/admin/compensations')
        .set(authHeader(tokenAdminPour(admin)));

      expect(res.status, res.text).toBe(200);
      expect(res.body.total).toBe(1);
      const item = res.body.items.find((c) => c.id === creation.body.id);
      expect(item).toBeTruthy();
      expect(item.supplier).toBeTruthy();
      expect(item.supplier.farmName).toBe('Ferme du Test');
      expect(item.supplier.payoutAccount).toBeTruthy();
      expect(item.supplier.payoutAccount.accountNumber).toBe('01234567890');
      expect(item.status).toBe('PENDING_APPROVAL');
    });

    it('filtre par statut', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '1000.00', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      const creation = await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));
      expect(creation.status, creation.text).toBe(201);

      const admin = await createUser({ role: 'ADMIN' });
      const token = authHeader(tokenAdminPour(admin));

      // Toutes les indemnisations créées sont PENDING_APPROVAL
      let res = await api()
        .get('/api/v2/admin/compensations?status=PENDING_APPROVAL')
        .set(token);
      expect(res.status, res.text).toBe(200);
      expect(res.body.items.every((c) => c.status === 'PENDING_APPROVAL')).toBe(true);
      expect(res.body.items.some((c) => c.id === creation.body.id)).toBe(true);

      res = await api()
        .get('/api/v2/admin/compensations?status=PAID')
        .set(token);
      expect(res.status, res.text).toBe(200);
      expect(res.body.total).toBe(0);
    });
  });

  describe('GET /api/v2/supplier/compensations', () => {
    it('un fournisseur ne voit que les siennes', async () => {
      const f1 = await fournisseur();
      const f2 = await fournisseur();
      const lot1 = await creerLot({ quantity: '100', agreedUnitPrice: '1000.00', fournisseur: f1 });
      const lot2 = await creerLot({ quantity: '50', agreedUnitPrice: '800.00', fournisseur: f2 });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      await demanderIndemnisation(lot1.id, 10, tokenPour(agentUser));
      await demanderIndemnisation(lot2.id, 5, tokenPour(agentUser));

      const res1 = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenFournisseurPour(f1.user)));
      expect(res1.status, res1.text).toBe(200);
      expect(res1.body.total).toBe(1);
      expect(res1.body.items).toHaveLength(1);
      // 10 x 1000 x 0.3333 = 3333
      expect(res1.body.items[0].amount).toBe(3333);

      const res2 = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenFournisseurPour(f2.user)));
      expect(res2.status, res2.text).toBe(200);
      expect(res2.body.total).toBe(1);
      expect(res2.body.items).toHaveLength(1);
      // 5 x 800 x 0.3333 = 1333,2 -> 1333 XAF
      expect(res2.body.items[0].amount).toBe(1333);
    });

    it('le DTO fournisseur expose motif, quantité, montant, statut sans fuite', async () => {
      const f = await fournisseur();
      const lot = await creerLot({ quantity: '100', agreedUnitPrice: '1000.00', fournisseur: f });
      const { user: agentUser } = await agentAvecCapacite(['DISPUTE_HANDLING']);

      await demanderIndemnisation(lot.id, 10, tokenPour(agentUser));

      const res = await api()
        .get('/api/v2/supplier/compensations')
        .set(authHeader(tokenFournisseurPour(f.user)));

      expect(res.status).toBe(200);
      const item = res.body.items[0];
      expect(item.reason).toBe('EXPIRED_UNSOLD');
      expect(item.quantity).toBe(10);
      expect(item.amount).toBe(3333);
      expect(item.status).toBe('PENDING_APPROVAL');
      // Aucune donnée de prix, de taux ni d'identité plateforme
      assertNoLeak(res.body, ['unitPrice', 'rate', 'supplierId', 'approvedById', 'paidById']);
    });
  });
});
