import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { createUser } from '../helpers/factory.js';
import {
  receiveLot,
  reserve,
  releaseReservation,
  commitSale,
  expireAvailable,
  returnAvailable,
} from '../../src/services/stock.service.js';

// Tests d'intégration du service de stock : chaque cas tourne dans une
// transaction Prisma dédiée, comme le ferait un contrôleur. Le setup global
// (tests/setup/hooks.js) vide la base avant chaque test.

const Decimal = Prisma.Decimal;

// lotCode, orderNumber et noms doivent être uniques en base : un compteur
// de fichier suffit, les fichiers de test tournent dans un seul processus.
let compteur = 0;
function identifiant(prefixe) {
  compteur += 1;
  return `${prefixe}-${Date.now()}-${compteur}`;
}

const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const HIER = new Date(Date.now() - 24 * 3600 * 1000);

// --- Fixtures ---

async function fournisseur() {
  const user = await createUser({ role: 'SUPPLIER' });
  const profile = await prisma.supplierProfile.create({
    data: { userId: user.id, farmName: 'Ferme du Test' },
  });
  return { user, profile };
}

async function produit({ perissable = false } = {}) {
  const [category, unit] = await Promise.all([
    prisma.productCategory.findFirst(),
    prisma.unit.findFirst(),
  ]);
  return prisma.product.create({
    data: {
      categoryId: category.id,
      unitId: unit.id,
      name: identifiant('Produit'),
      isPerishable: perissable,
    },
  });
}

async function zone() {
  return prisma.zone.create({ data: { name: identifiant('Zone') } });
}

// Lot PENDING_VALIDATION de 100 unités, disponible à 100, non expiré.
async function lotDe100(overrides = {}) {
  const { profile } = await fournisseur();
  const product = await produit();
  const zoneTest = await zone();
  return prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId: profile.id,
      productId: product.id,
      zoneId: zoneTest.id,
      agreedUnitPrice: '1000.00',
      quantityInitial: new Decimal(100),
      quantityAvailable: new Decimal(100),
      expiresAt: DANS_7_JOURS,
      ...overrides,
    },
  });
}

// Sommes des quantityDelta par type de mouvement. Le mouvement RECEIVED est
// exclu : il trace la quantité initiale (point de départ), pas un compteur
// courant. Chaque quantité déplacée est signée (+ quand elle rejoint son
// compteur, - quand elle le quitte).
async function sommesMouvements(lotId) {
  const mouvements = await prisma.stockMovement.findMany({
    where: { lotId, type: { not: 'RECEIVED' } },
  });
  const sommes = {};
  for (const type of ['RESERVED', 'RESERVATION_RELEASED', 'SOLD', 'EXPIRED', 'RETURNED']) {
    sommes[type] = mouvements
      .filter((m) => m.type === type)
      .reduce((acc, m) => acc.plus(m.quantityDelta), new Decimal(0));
  }
  return sommes;
}

// Les trois relations d'équilibre du journal. quantityReserved est alimenté
// par RESERVED (+) puis décrémente par RESERVATION_RELEASED (déjà négatif)
// et par SOLD (la quantité réservée devient vendue).
async function verifierJournal(lotId) {
  const lot = await prisma.stockLot.findUnique({ where: { id: lotId } });
  const s = await sommesMouvements(lotId);
  expect(s.RESERVED.plus(s.RESERVATION_RELEASED).minus(s.SOLD).equals(lot.quantityReserved)).toBe(true);
  expect(s.SOLD.equals(lot.quantitySold)).toBe(true);
  expect(s.EXPIRED.plus(s.RETURNED).equals(lot.quantityLost)).toBe(true);
}

describe('Service de stock — réception', () => {
  it('receiveLot passe un lot PENDING_VALIDATION à AVAILABLE et trace RECEIVED', async () => {
    const { user } = await fournisseur();
    const lot = await lotDe100();

    const recu = await prisma.$transaction((tx) => receiveLot(tx, lot.id, { actorUserId: user.id }));

    expect(recu.status).toBe('AVAILABLE');
    expect(recu.quantityAvailable.toNumber()).toBe(100);

    const mouvements = await prisma.stockMovement.findMany({ where: { lotId: lot.id } });
    expect(mouvements).toHaveLength(1);
    expect(mouvements[0].type).toBe('RECEIVED');
    expect(mouvements[0].quantityDelta.toNumber()).toBe(100);
    expect(mouvements[0].actorUserId).toBe(user.id);
  });

  it('receiveLot refuse un lot déjà AVAILABLE (409 INVALID_STATE_TRANSITION)', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await expect(prisma.$transaction((tx) => receiveLot(tx, lot.id, {}))).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('Service de stock — anti-survente en parallèle', () => {
  // Le cas qui motive le service : 10 réservations de 15 sur un lot de 100,
  // chacune dans sa propre transaction. Exactement 6 doivent réussir (90
  // réservés), 4 échouer en INSUFFICIENT_STOCK, et l'invariant doit tenir.
  it('6 réservations de 15 réussissent, 4 échouent, l invariant tient', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    const resultats = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        prisma.$transaction((tx) => reserve(tx, lot.id, 15, {}))
      )
    );

    const succes = resultats.filter((r) => r.status === 'fulfilled');
    const echecs = resultats.filter((r) => r.status === 'rejected');
    expect(succes).toHaveLength(6);
    expect(echecs).toHaveLength(4);
    for (const echec of echecs) {
      expect(echec.reason.statusCode).toBe(409);
      expect(echec.reason.code).toBe('INSUFFICIENT_STOCK');
    }

    const final = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(final.quantityAvailable.toNumber()).toBe(10);
    expect(final.quantityReserved.toNumber()).toBe(90);
    expect(final.quantitySold.toNumber()).toBe(0);
    expect(final.quantityLost.toNumber()).toBe(0);
    expect(final.status).toBe('AVAILABLE');

    // Invariant : initial = disponible + réservé + vendu + perdu.
    const somme = new Decimal(final.quantityAvailable)
      .plus(final.quantityReserved)
      .plus(final.quantitySold)
      .plus(final.quantityLost);
    expect(somme.equals(final.quantityInitial)).toBe(true);

    // Le journal des mouvements équilibre les compteurs.
    await verifierJournal(lot.id);
  });

  it('une réservation supérieure au disponible est refusée', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await expect(
      prisma.$transaction((tx) => reserve(tx, lot.id, 101, {}))
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });

    // Le lot est resté intact : la transaction refusée n'a rien écrit.
    const final = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(final.quantityAvailable.toNumber()).toBe(100);
    expect(final.quantityReserved.toNumber()).toBe(0);
  });

  it('réserver jusqu à épuisement passe le lot en FULLY_RESERVED', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    const recu = await prisma.$transaction((tx) => reserve(tx, lot.id, 100, {}));
    expect(recu.status).toBe('FULLY_RESERVED');
    expect(recu.quantityAvailable.toNumber()).toBe(0);
    expect(recu.quantityReserved.toNumber()).toBe(100);
  });
});

describe('Service de stock — cycles de vie', () => {
  it('reserve -> release rend le stock disponible', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await prisma.$transaction((tx) => reserve(tx, lot.id, 30, {}));
    let courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.quantityReserved.toNumber()).toBe(30);
    expect(courant.quantityAvailable.toNumber()).toBe(70);
    expect(courant.status).toBe('AVAILABLE');

    await prisma.$transaction((tx) => releaseReservation(tx, lot.id, 30, {}));
    courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.quantityReserved.toNumber()).toBe(0);
    expect(courant.quantityAvailable.toNumber()).toBe(100);
    expect(courant.status).toBe('AVAILABLE');

    // Mouvements : +30 (RESERVED) puis -30 (RESERVATION_RELEASED) = 0.
    await verifierJournal(lot.id);
  });

  it('libérer plus que le réservé est refusé (409 INSUFFICIENT_RESERVATION)', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));
    await prisma.$transaction((tx) => reserve(tx, lot.id, 10, {}));

    await expect(
      prisma.$transaction((tx) => releaseReservation(tx, lot.id, 11, {}))
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_RESERVATION' });
  });

  it('reserve -> commitSale vend le lot', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await prisma.$transaction((tx) => reserve(tx, lot.id, 30, {}));
    await prisma.$transaction((tx) => commitSale(tx, lot.id, 30, {}));

    const courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.quantitySold.toNumber()).toBe(30);
    expect(courant.quantityReserved.toNumber()).toBe(0);
    expect(courant.quantityAvailable.toNumber()).toBe(70);
    expect(courant.status).toBe('AVAILABLE');

    // Le journal équilibre les compteurs : SOLD = 30, réservé = 0.
    await verifierJournal(lot.id);
  });

  it('vendre tout le réservé puis tout le disponible donne SOLD_OUT', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await prisma.$transaction((tx) => reserve(tx, lot.id, 100, {}));
    let courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.status).toBe('FULLY_RESERVED');

    await prisma.$transaction((tx) => commitSale(tx, lot.id, 100, {}));
    courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.status).toBe('SOLD_OUT');
    expect(courant.quantitySold.toNumber()).toBe(100);
  });

  it('vendre plus que le réservé est refusé (409 INSUFFICIENT_RESERVATION)', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));
    await prisma.$transaction((tx) => reserve(tx, lot.id, 10, {}));

    await expect(
      prisma.$transaction((tx) => commitSale(tx, lot.id, 11, {}))
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_RESERVATION' });
  });
});

describe('Service de stock — péremption et retour', () => {
  it('expireAvailable déplace tout le disponible vers perdu et renvoie la quantité', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));
    await prisma.$transaction((tx) => reserve(tx, lot.id, 30, {}));

    const perdue = await prisma.$transaction((tx) => expireAvailable(tx, lot.id, {}));
    expect(perdue.toNumber()).toBe(70);

    const courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.quantityAvailable.toNumber()).toBe(0);
    expect(courant.quantityLost.toNumber()).toBe(70);
    expect(courant.quantityReserved.toNumber()).toBe(30);
    expect(courant.status).toBe('EXPIRED');

    // Le journal équilibre les compteurs : EXPIRED = 70, réservé = 30.
    await verifierJournal(lot.id);
  });

  it('expireAvailable sur un lot déjà sans disponible ne crée pas de mouvement', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));
    await prisma.$transaction((tx) => reserve(tx, lot.id, 100, {}));

    const perdue = await prisma.$transaction((tx) => expireAvailable(tx, lot.id, {}));
    expect(perdue.toNumber()).toBe(0);

    const courant = await prisma.stockLot.findUnique({ where: { id: lot.id } });
    expect(courant.status).toBe('EXPIRED');
    expect(courant.quantityAvailable.toNumber()).toBe(0);
    expect(courant.quantityReserved.toNumber()).toBe(100);
    expect(courant.quantityLost.toNumber()).toBe(0);
  });

  it('returnAvailable (RETURNED) déplace le disponible vers perdu et clôt le lot', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    const recu = await prisma.$transaction((tx) =>
      returnAvailable(tx, lot.id, 40, {}, 'RETURNED')
    );
    expect(recu.status).toBe('RETURNED');
    expect(recu.quantityAvailable.toNumber()).toBe(60);
    expect(recu.quantityLost.toNumber()).toBe(40);

    const mouvements = await prisma.stockMovement.findMany({ where: { lotId: lot.id } });
    const retours = mouvements.filter((m) => m.type === 'RETURNED');
    expect(retours).toHaveLength(1);
    expect(retours[0].quantityDelta.toNumber()).toBe(40);
  });

  it('returnAvailable (WITHDRAWN) clôt le lot comme retiré', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    const recu = await prisma.$transaction((tx) =>
      returnAvailable(tx, lot.id, 25, {}, 'WITHDRAWN')
    );
    expect(recu.status).toBe('WITHDRAWN');
    expect(recu.quantityLost.toNumber()).toBe(25);
  });

  it('returnAvailable refuse un finalStatus invalide', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await expect(
      prisma.$transaction((tx) => returnAvailable(tx, lot.id, 10, {}, 'SOLD_OUT'))
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_FINAL_STATUS' });
  });

  it('returnAvailable refuse de retourner plus que le disponible', async () => {
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, {}));

    await expect(
      prisma.$transaction((tx) => returnAvailable(tx, lot.id, 101, {}, 'RETURNED'))
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
  });
});

describe('Service de stock — journal des mouvements', () => {
  // orderItem est une FK réelle : le mouvement SOLD d'une commande pointe
  // vers une ligne de commande qui existe.
  it('trace l acteur utilisateur, l agent et la commande sur les mouvements', async () => {
    const { user } = await fournisseur();
    const agent = await prisma.agent.create({
      data: { kind: 'HUMAN', displayName: 'Agent Test' },
    });
    const lot = await lotDe100();
    await prisma.$transaction((tx) => receiveLot(tx, lot.id, { actorUserId: user.id }));

    // Commande minimale pour obtenir un orderItem réel.
    const acheteur = await createUser({ role: 'BUYER' });
    const deliveryMode = await prisma.deliveryMode.findFirst();
    const commande = await prisma.order.create({
      data: {
        orderNumber: identifiant('CMD'),
        buyerId: acheteur.id,
        deliveryModeId: deliveryMode.id,
        subtotal: '10000.00',
        total: '10000.00',
      },
    });
    const ligne = await prisma.orderItem.create({
      data: {
        orderId: commande.id,
        lotId: lot.id,
        quantity: new Decimal(10),
        unitPrice: '1000.00',
        supplierUnitPrice: '900.00',
        lineTotal: '10000.00',
        commissionRate: '0.1000',
        commissionAmount: '1000.00',
        supplierNetAmount: '9000.00',
      },
    });

    await prisma.$transaction((tx) =>
      reserve(tx, lot.id, 10, {
        actorAgentId: agent.id,
        orderItemId: ligne.id,
        note: 'Commande confirmée',
      })
    );

    const mouvements = await prisma.stockMovement.findMany({
      where: { lotId: lot.id },
      orderBy: { id: 'asc' },
    });
    expect(mouvements).toHaveLength(2);

    expect(mouvements[0].type).toBe('RECEIVED');
    expect(mouvements[0].quantityDelta.toNumber()).toBe(100);
    expect(mouvements[0].actorUserId).toBe(user.id);

    expect(mouvements[1].type).toBe('RESERVED');
    expect(mouvements[1].quantityDelta.toNumber()).toBe(10);
    expect(mouvements[1].actorAgentId).toBe(agent.id);
    expect(mouvements[1].orderItemId).toBe(ligne.id);
    expect(mouvements[1].note).toBe('Commande confirmée');
  });
});
