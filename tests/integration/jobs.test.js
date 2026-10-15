import { describe, it, expect, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { createUser, createListingForLot } from '../helpers/factory.js';
import { reserve, releaseReservation } from '../../src/services/stock.service.js';
import { roundMoney, toNumber } from '../../src/utils/money.js';
import { releaseExpiredReservations } from '../../src/jobs/releaseExpiredReservations.js';
import { expireLots } from '../../src/jobs/expireLots.js';
import { expiryAlerts } from '../../src/jobs/expiryAlerts.js';

// Tests des tâches planifiées (plan v2, P6.3) : chaque fonction est appelée
// directement avec un `now` contrôlé, sans passer par le scheduler.

const Decimal = Prisma.Decimal;

// --- Fixtures ---

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

async function lookupId(model, code) {
  const row = await prisma[model].findUnique({ where: { code } });
  if (!row) throw new Error(`Table de référence non peuplée : ${model}.${code}`);
  return row.id;
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

async function creerLot({ quantity = '100', agreedUnitPrice = '1000.00', expiresAt, status = 'AVAILABLE', overrides = {} } = {}) {
  const { profile } = await fournisseur();
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
      expiresAt,
      status,
      ...overrides,
    },
  });
}

// Devis QUOTED avec une réservation de stock, créé directement en base : le
// test porte sur le job, pas sur la route staff de création de devis.
async function creerDevis({ quantity = '5', reservedUntil, quantityLot = '10' } = {}) {
  const buyer = await createUser({ role: 'BUYER' });
  const lot = await creerLot({ quantity: quantityLot });
  const annonce = await createListingForLot(lot);
  const deliveryModeId = await lookupId('deliveryMode', 'HUB_PICKUP');
  const quantite = new Decimal(quantity);
  const prix = new Decimal('1200.00');
  const lineTotal = quantite.mul(prix);
  const order = await prisma.order.create({
    data: {
      orderNumber: identifiant('CMD'),
      buyerId: buyer.id,
      deliveryModeId,
      status: 'QUOTED',
      reservedUntil,
      subtotal: lineTotal,
      total: lineTotal,
      items: {
        create: [{
          listingId: annonce.id,
          lotId: lot.id,
          quantity: quantite,
          unitPrice: prix,
          supplierUnitPrice: lot.agreedUnitPrice,
          lineTotal,
          commissionRate: new Decimal('0.1'),
          commissionAmount: lineTotal.mul(new Decimal('0.1')),
          supplierNetAmount: lineTotal.mul(new Decimal('0.9')),
        }],
      },
    },
  });
  // Réservation du stock, comme le ferait la route staff
  await prisma.$transaction((tx) => reserve(tx, lot.id, quantity, {}));
  return { order, lot, annonce };
}

// --- Tests ---

describe('Tâches planifiées (P6.3)', () => {
  const NOW = new Date('2026-10-14T12:00:00.000Z');

  it('annule un devis expiré et libère le stock réservé', async () => {
    const { order, lot } = await creerDevis({
      quantity: '5',
      reservedUntil: new Date('2026-10-14T11:00:00.000Z'), // expiré
    });
    // Un devis non expiré ne doit pas être touché
    const { order: orderFrais, lot: lotFrais } = await creerDevis({
      quantity: '5',
      reservedUntil: new Date('2026-10-14T13:00:00.000Z'),
    });

    const annulees = await releaseExpiredReservations(prisma, NOW);

    expect(annulees).toEqual([order.id]);

    const maj = await prisma.order.findUnique({ where: { id: order.id } });
    expect(maj.status).toBe('CANCELLED');
    expect(maj.cancelledAt).not.toBeNull();
    expect(maj.cancellationReason).toBe('Devis expiré');

    // Le stock réservé est retourné au disponible
    const lotMaj = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(toNumber(lotMaj.quantityAvailable)).toBe(10);
    expect(toNumber(lotMaj.quantityReserved)).toBe(0);

    // Mouvement de libération rattaché au lot
    const mouvement = await prisma.stockMovement.findFirst({
      where: { lotId: lot.id, type: 'RESERVATION_RELEASED' },
    });
    expect(mouvement).not.toBeNull();

    // Audit avec acteur système : colonnes acteur nulles, raison tracée
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ORDER_CANCELLED', entityType: 'Order', entityId: order.id },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBeNull();
    expect(audit.actorAgentId).toBeNull();
    expect(audit.metadata).toMatchObject({ reason: 'Devis expiré' });

    // Le devis non expiré est intact
    const majFrais = await prisma.order.findUnique({ where: { id: orderFrais.id } });
    expect(majFrais.status).toBe('QUOTED');
    const lotFraisMaj = await prisma.stockLot.findUnique({ where: { id: lotFrais.id } });
    expect(toNumber(lotFraisMaj.quantityReserved)).toBe(5);
  });

  it('expire un lot invendu et crée une indemnisation PENDING_APPROVAL', async () => {
    const lot = await creerLot({
      quantity: '10',
      expiresAt: new Date('2026-10-14T11:00:00.000Z'), // expiré
    });

    const resultats = await expireLots(prisma, NOW);

    expect(resultats).toHaveLength(1);
    expect(resultats[0].lotId).toBe(lot.id);
    expect(toNumber(resultats[0].quantite)).toBe(10);

    // Le disponible est devenu perte, statut EXPIRED (computeLotStatus)
    const lotMaj = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(toNumber(lotMaj.quantityAvailable)).toBe(0);
    expect(toNumber(lotMaj.quantityLost)).toBe(10);
    expect(lotMaj.status).toBe('EXPIRED');

    // Mouvement EXPIRED
    const mouvement = await prisma.stockMovement.findFirst({
      where: { lotId: lot.id, type: 'EXPIRED' },
    });
    expect(mouvement).not.toBeNull();

    // Indemnisation PENDING_APPROVAL, raison EXPIRED_UNSOLD
    const indemnisation = await prisma.supplierCompensation.findFirst({
      where: { lotId: lot.id },
    });
    expect(indemnisation).not.toBeNull();
    expect(indemnisation.status).toBe('PENDING_APPROVAL');
    expect(indemnisation.reason).toBe('EXPIRED_UNSOLD');
    expect(toNumber(indemnisation.quantity)).toBe(10);
    // Montant = quantité x prix convenu x taux (règle de compensation.service)
    const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
    const montantAttendu = roundMoney(
      new Decimal(10).mul(new Decimal('1000.00')).mul(new Decimal(settings.expiryCompensationRate)),
      settings.currency
    );
    expect(indemnisation.amount.equals(montantAttendu)).toBe(true);

    // Idempotence : le lot n'a plus de disponible, rien à faire
    const second = await expireLots(prisma, NOW);
    expect(second).toEqual([]);
    const indemnisations = await prisma.supplierCompensation.count({ where: { lotId: lot.id } });
    expect(indemnisations).toBe(1);
  });

  it('ne traite pas un lot dont le disponible est entièrement réservé', async () => {
    // Lot expiré, tout le stock en réservation : expireLots ne sélectionne
    // que quantityAvailable > 0, donc ce lot attend la libération.
    const lot = await creerLot({
      quantity: '5',
      expiresAt: new Date('2026-10-14T11:00:00.000Z'),
      status: 'FULLY_RESERVED',
      overrides: { quantityAvailable: new Decimal(0), quantityReserved: new Decimal(5) },
    });

    const resultats = await expireLots(prisma, NOW);

    expect(resultats).toEqual([]);
    const lotMaj = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(toNumber(lotMaj.quantityAvailable)).toBe(0);
    expect(toNumber(lotMaj.quantityReserved)).toBe(5);
    expect(toNumber(lotMaj.quantityLost)).toBe(0);
    const indemnisations = await prisma.supplierCompensation.count({ where: { lotId: lot.id } });
    expect(indemnisations).toBe(0);

    // Une fois la réservation libérée (annulation du devis), le lot redevient
    // disponible et le passage suivant le traite.
    await prisma.$transaction((tx) => releaseReservation(tx, lot.id, '5', {}));
    const second = await expireLots(prisma, NOW);
    expect(second).toHaveLength(1);
    expect(second[0].lotId).toBe(lot.id);
    const lotApres = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(toNumber(lotApres.quantityLost)).toBe(5);
    const indemnisation = await prisma.supplierCompensation.findFirst({
      where: { lotId: lot.id },
    });
    expect(indemnisation).not.toBeNull();
    expect(indemnisation.status).toBe('PENDING_APPROVAL');
  });

  it('reduit l indemnisation au reste indemnisable quand une indemnisation existe deja', async () => {
    const lot = await creerLot({
      quantity: '10',
      expiresAt: new Date('2026-10-14T11:00:00.000Z'), // expiré
    });
    // Indemnisation antérieure : 6 sur 10 déjà indemnisés.
    await prisma.supplierCompensation.create({
      data: {
        supplierId: lot.supplierId,
        lotId: lot.id,
        reason: 'LOST_OR_DAMAGED',
        quantity: '6',
        unitPrice: '1000',
        rate: '1',
        amount: '6000',
        status: 'PENDING_APPROVAL',
      },
    });

    const resultats = await expireLots(prisma, NOW);

    expect(resultats).toHaveLength(1);
    expect(resultats[0].lotId).toBe(lot.id);
    // resultats[0].quantite est la quantite perdue (10), pas la quantite
    // indemisee : lire l indemnisation en base.
    expect(toNumber(resultats[0].quantite)).toBe(10);

    const indemnisation = await prisma.supplierCompensation.findFirst({
      where: { lotId: lot.id, reason: 'EXPIRED_UNSOLD' },
    });
    expect(indemnisation).not.toBeNull();
    expect(toNumber(indemnisation.quantity)).toBe(4);
    expect(indemnisation.note).toBe('Quantité réduite au reste indemnisable');
  });

  it('ne cree rien quand le lot est deja integralement indemnise', async () => {
    const lot = await creerLot({
      quantity: '10',
      expiresAt: new Date('2026-10-14T11:00:00.000Z'),
    });
    await prisma.supplierCompensation.create({
      data: {
        supplierId: lot.supplierId,
        lotId: lot.id,
        reason: 'LOST_OR_DAMAGED',
        quantity: '10',
        unitPrice: '1000',
        rate: '1',
        amount: '10000',
        status: 'PENDING_APPROVAL',
      },
    });

    const resultats = await expireLots(prisma, NOW);

    // Le lot est expiré (quantité en perte) mais le plafond cumul est déjà
    // atteint : aucune indemnisation ajoutée.
    expect(resultats).toHaveLength(1);
    expect(resultats[0].lotId).toBe(lot.id);
    expect(resultats[0].compensationId).toBeNull();
    const lotMaj = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(toNumber(lotMaj.quantityLost)).toBe(10);
    const indemnisations = await prisma.supplierCompensation.count({ where: { lotId: lot.id } });
    expect(indemnisations).toBe(1);
  });

  it('ne fait rien lors d une seconde exécution (idempotence)', async () => {
    const { order, lot } = await creerDevis({
      quantity: '5',
      reservedUntil: new Date('2026-10-14T11:00:00.000Z'),
    });
    await releaseExpiredReservations(prisma, NOW);
    const annulees = await releaseExpiredReservations(prisma, NOW);
    expect(annulees).toEqual([]);
    // Aucun doublon : un seul mouvement de libération, un seul audit
    const mouvements = await prisma.stockMovement.count({
      where: { lotId: lot.id, type: 'RESERVATION_RELEASED' },
    });
    expect(mouvements).toBe(1);
    const audits = await prisma.auditLog.count({
      where: { action: 'ORDER_CANCELLED', entityId: order.id },
    });
    expect(audits).toBe(1);
  });

  it('émet les alertes d expiration sans écrire en base', async () => {
    const lotBientot = await creerLot({
      quantity: '10',
      expiresAt: new Date('2026-10-15T12:00:00.000Z'), // dans 24 h
    });
    await creerLot({
      quantity: '10',
      expiresAt: new Date('2026-11-14T12:00:00.000Z'), // dans 31 jours : hors fenêtre
    });
    const agence = await prisma.transportAgency.create({
      data: {
        name: identifiant('Agence'),
        phone: '+33600000000',
        insuranceExpiresAt: new Date('2026-10-29T12:00:00.000Z'), // dans 15 jours
        isActive: true,
      },
    });
    await prisma.transportAgency.create({
      data: {
        name: identifiant('Agence'),
        phone: '+33600000001',
        insuranceExpiresAt: new Date('2026-12-14T12:00:00.000Z'), // dans 60 jours : hors fenêtre
        isActive: true,
      },
    });

    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    const avant = {
      audits: await prisma.auditLog.count(),
      compensations: await prisma.supplierCompensation.count(),
      mouvements: await prisma.stockMovement.count(),
    };

    const { lots, agencies } = await expiryAlerts(prisma, NOW, io);

    // Un seul événement vers la room staff
    expect(io.to).toHaveBeenCalledWith('staff');
    expect(emit).toHaveBeenCalledTimes(1);
    const [evenement, payload] = emit.mock.calls[0];
    expect(evenement).toBe('alert:expiring');
    expect(payload.lots).toHaveLength(1);
    expect(payload.lots[0].id).toBe(lotBientot.id);
    expect(payload.agences).toHaveLength(1);
    expect(payload.agences[0].id).toBe(agence.id);

    // Aucune écriture en base
    expect(await prisma.auditLog.count()).toBe(avant.audits);
    expect(await prisma.supplierCompensation.count()).toBe(avant.compensations);
    expect(await prisma.stockMovement.count()).toBe(avant.mouvements);
  });

  it('n alerte pas sur un lot SOLD_OUT', async () => {
    // Un lot SOLD_OUT avec du disponible (compteurs incohérents) ne doit pas
    // déclencher d'alerte : il n'y a plus rien à sauver.
    await creerLot({
      quantity: '10',
      expiresAt: new Date('2026-10-15T12:00:00.000Z'), // dans 24 h
      status: 'SOLD_OUT',
      overrides: { quantityAvailable: new Decimal(10) },
    });

    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    const { lots } = await expiryAlerts(prisma, NOW, io);

    expect(lots).toHaveLength(0);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].lots).toHaveLength(0);
  });
});
