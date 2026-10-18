import { describe, it, expect } from 'vitest';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, createVerifiedUser, createListingForLot, createSession } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';
import { assertNoLeak } from '../helpers/assertNoLeak.js';

const Decimal = Prisma.Decimal;
const DANS_7_JOURS = new Date(Date.now() + 7 * 24 * 3600 * 1000);

// Buffers minimaux : multer ne regarde que le mimetype déclaré, pas le contenu.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function identifiant(prefixe) {
  return `${prefixe}-${Date.now()}-${randomInt(1_000, 9_999)}`;
}

function tokenPour(user, role) {
  const levels = { BUYER: 10, SUPPLIER: 10, DRIVER: 10, AGENT: 30, ADMIN: 50 };
  return generateToken({ id: user.id, role: { code: role, level: levels[role] } });
}

// --- Fabriques locales ---

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

// --- Clés interdites par rôle ---
//
// Acheteur : aucune donnée interne (lot, fournisseur, prix convenu, adresse
// de retrait) ni contact d'un tiers ne doit transparaître dans ses réponses.
const CLES_ACHETEUR = [
  'lotId',
  'lotCode',
  'supplierId',
  'farmName',
  'agreedUnitPrice',
  'supplierUnitPrice',
  'pickupAddress',
  'pickupLatitude',
  'pickupLongitude',
  'commissionRate',
  'commissionAmount',
  'supplierNetAmount',
  'origins',
];
// Sur les routes où un tiers peut apparaître (commandes, conversations),
// le phone et l'email sont aussi interdits — sur /me, ce sont les siens.
const CLES_ACHETEUR_TIERS = [...CLES_ACHETEUR, 'phone', 'email'];

// Fournisseur : aucun identifiant ni nom d'acheteur (ou de tout tiers).
const CLES_FOURNISSEUR = [
  'buyerId',
  'buyerFirstname',
  'buyerLastname',
  'buyerEmail',
  'buyerPhone',
  'customerId',
  'customerFirstname',
  'customerLastname',
  'customerEmail',
  'customerPhone',
];
// Sur les routes où un tiers peut apparaître, le nom et le contact sont
// interdits — sur /me, ce sont les siens.
const CLES_FOURNISSEUR_TIERS = [...CLES_FOURNISSEUR, 'firstname', 'lastname', 'email', 'phone'];

// Livreur : aucun montant ni prix — il transporte la marchandise, il n'a pas
// à en connaître la valeur. (Le rewardAmount de son propre parrainage est une
// donnée personnelle le concernant, pas un prix de livraison.)
// 'total' est exclu : c'est le compteur du wrapper de pagination, pas un montant.
const CLES_LIVREUR = [
  'agencyCost',
  'deliveryFee',
  'insuredValue',
  'amount',
  'unitPrice',
  'subtotal',
  'fee',
  'cost',
  'commission',
  'agreedUnitPrice',
  'supplierUnitPrice',
  'grossAmount',
  'netAmount',
  'buyerFee',
  'lineTotal',
  'baseFee',
  'perKmFee',
  'price',
  'value',
  'insurancePolicyNumber',
];

// --- Helpers ---

// Applique assertNoLeak en contextualisant l'erreur : un échec indique
// immédiatement quelle route a fuité.
async function verifier(description, res, clesInterdites) {
  try {
    assertNoLeak(res.body, clesInterdites);
  } catch (err) {
    throw new Error(`${description} [${res.status}]: ${err.message}`);
  }
  return res;
}

// --- Scénario complet ---
//
// Acheteur, fournisseur, agent, livreur, lot, annonce, conversation, devis
// (commande QUOTED), commande confirmée et livraison acceptée. Le scénario
// est reconstruit dans chaque test : le beforeEach global vide la base.
async function scenarioComplet() {
  // Acheteur (profil vérifié : il confirme le devis)
  const buyer = await createVerifiedUser({ role: 'BUYER' });
  await prisma.buyerProfile.create({
    data: { userId: buyer.id, buyerType: 'WHOLESALER', businessName: 'Grossiste Test' },
  });

  // Fournisseur (profil vérifié : il déclare un lot via l'API)
  const supplierUser = await createVerifiedUser({ role: 'SUPPLIER' });
  const supplierProfile = await prisma.supplierProfile.create({
    data: { userId: supplierUser.id, farmName: 'Ferme du Test' },
  });

  // Agent (ORDER_PROCESSING pour le devis, DISPATCH_COORDINATION pour la livraison)
  const agentUser = await createUser({ role: 'AGENT' });
  const agent = await prisma.agent.create({
    data: { kind: 'HUMAN', userId: agentUser.id, displayName: 'Agent Test', isActive: true },
  });
  for (const code of ['ORDER_PROCESSING', 'LISTING_MANAGEMENT', 'DISPATCH_COORDINATION']) {
    const cap = await prisma.agentCapability.findFirst({ where: { code } });
    await prisma.agentCapabilityLink.create({ data: { agentId: agent.id, capabilityId: cap.id } });
  }

  // Agence + livreur
  const zoneLivraison = await zone();
  const agency = await prisma.transportAgency.create({
    data: { name: identifiant('Agence'), phone: '+33600000000', isActive: true },
  });
  await prisma.agencyZone.create({
    data: { agencyId: agency.id, zoneId: zoneLivraison.id, baseFee: '500', perKmFee: '100', isActive: true },
  });
  const driverUser = await createUser({ role: 'DRIVER' });
  await prisma.driverProfile.create({
    data: { userId: driverUser.id, agencyId: agency.id, vehicleType: 'Moto', plateNumber: 'AA-123-BB' },
  });

  // Lot + annonce
  const product = await produit();
  const zoneLot = await zone();
  const lot = await prisma.stockLot.create({
    data: {
      lotCode: identifiant('LOT'),
      supplierId: supplierProfile.id,
      productId: product.id,
      zoneId: zoneLot.id,
      agreedUnitPrice: '1000.00',
      quantityInitial: new Decimal('10'),
      quantityAvailable: new Decimal('10'),
      storageType: 'SUPPLIER_SITE',
      pickupAddress: '12 route de la ferme',
      pickupLatitude: 12.34,
      pickupLongitude: -5.67,
      expiresAt: DANS_7_JOURS,
      status: 'AVAILABLE',
    },
  });
  const annonce = await createListingForLot(lot);
  await prisma.listing.update({ where: { id: annonce.id }, data: { unitPrice: '1200.00' } });

  // Conversation acheteur -> équipe
  const conversation = await prisma.conversation.create({
    data: { type: 'BUYER_SUPPORT', customerId: buyer.id, status: 'OPEN', listingId: annonce.id },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, senderType: 'CUSTOMER', senderUserId: buyer.id, content: 'Bonjour, je souhaite un devis.' },
  });

  // Devis QUOTED via la route staff (comme en production)
  const tokenAgent = tokenPour(agentUser, 'AGENT');
  const resDevis = await api()
    .post('/api/v2/staff/orders')
    .set(authHeader(tokenAgent))
    .send({
      buyerId: buyer.id,
      items: [{ listingId: annonce.id, quantity: 5 }],
      deliveryMode: 'AGENCY_DELIVERY',
      delivery: { zoneId: zoneLivraison.id, address: '10 avenue de la Gare', latitude: 48.85, longitude: 2.35 },
    });
  expect(resDevis.status, resDevis.text).toBe(201);
  const orderId = resDevis.body.id;

  // Commande confirmée par l'acheteur
  const tokenBuyer = tokenPour(buyer, 'BUYER');
  const resConfirm = await api()
    .post(`/api/v2/orders/${orderId}/confirm`)
    .set(authHeader(tokenBuyer));
  expect(resConfirm.status, resConfirm.text).toBe(200);

  // La commande passe en PREPARING + PAID (création des livraisons)
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PREPARING', paymentStatus: 'PAID' },
  });

  // Livraison créée via la route staff
  const resDelivery = await api()
    .post(`/api/v2/staff/orders/${orderId}/deliveries`)
    .set(authHeader(tokenAgent))
    .send({});
  expect(resDelivery.status, resDelivery.text).toBe(201);
  const deliveryId = resDelivery.body[0].id;

  // Le livreur accepte la course
  const tokenDriver = tokenPour(driverUser, 'DRIVER');
  const resAccept = await api()
    .post(`/api/v2/driver/deliveries/${deliveryId}/accept`)
    .set(authHeader(tokenDriver));
  expect(resAccept.status, resAccept.text).toBe(200);

  // Sessions (pour /sessions)
  await createSession(buyer);
  await createSession(buyer);
  await createSession(supplierUser);
  await createSession(driverUser);

  // Comptes de paiement (acheteur + fournisseur)
  const payoutBuyer = await prisma.payoutAccount.create({
    data: { userId: buyer.id, method: 'MOBILE_MONEY', accountNumber: '1234567890', accountName: 'Acheteur Test' },
  });
  const payoutSupplier = await prisma.payoutAccount.create({
    data: { userId: supplierUser.id, method: 'BANK_TRANSFER', accountNumber: '0987654321', accountName: 'Fournisseur Test' },
  });

  // Reversement du fournisseur (créé par confirmOrder, récupéré ici)
  const payout = await prisma.supplierPayout.findFirst({ where: { orderId } });
  expect(payout).toBeTruthy();

  // Compensation du fournisseur
  await prisma.supplierCompensation.create({
    data: {
      supplierId: supplierProfile.id,
      lotId: lot.id,
      reason: 'LOST_OR_DAMAGED',
      quantity: new Decimal('2'),
      unitPrice: new Decimal('1000'),
      rate: new Decimal('0.1'),
      amount: new Decimal('200'),
      status: 'PENDING_APPROVAL',
    },
  });

  // Parrainage (acheteur + fournisseur) — deux filleuls distincts :
  // un filleul ne peut être parrainé qu'une fois (contrainte unique).
  const filleul1 = await createUser({ role: 'BUYER', firstname: 'Filleul', lastname: 'Un', phone: '+33699999999', email: 'filleul1@example.com' });
  await prisma.referral.create({
    data: { referrerId: buyer.id, referredId: filleul1.id, kind: 'BUYER', status: 'ELIGIBLE', rewardAmount: new Decimal('500') },
  });
  const filleul2 = await createUser({ role: 'BUYER', firstname: 'Filleul', lastname: 'Deux', phone: '+33699999998', email: 'filleul2@example.com' });
  await prisma.referral.create({
    data: { referrerId: supplierUser.id, referredId: filleul2.id, kind: 'BUYER', status: 'PENDING', rewardAmount: new Decimal('0') },
  });

  return {
    buyer,
    supplierUser,
    driverUser,
    lot,
    annonce,
    conversation,
    orderId,
    deliveryId,
    payoutBuyer,
    payoutSupplier,
    product,
    zoneLot,
  };
}

// --- Tests ---

describe('Confidentialité — acheteur', () => {
  it('aucune donnée interne ni contact de tiers ne fuite sur aucune route acheteur', async () => {
    const ctx = await scenarioComplet();
    const token = tokenPour(ctx.buyer, 'BUYER');

    // Catalogue
    await verifier('GET /catalog/categories', await api().get('/api/v2/catalog/categories').set(authHeader(token)), CLES_ACHETEUR);
    await verifier('GET /catalog/listings', await api().get('/api/v2/catalog/listings').set(authHeader(token)), CLES_ACHETEUR);
    const resAnnonce = await api().get(`/api/v2/catalog/listings/${ctx.annonce.id}`).set(authHeader(token));
    expect(resAnnonce.status, resAnnonce.text).toBe(200);
    await verifier('GET /catalog/listings/:id', resAnnonce, CLES_ACHETEUR);

    // Conversations
    const resConv = await api()
      .post('/api/v2/conversations')
      .set(authHeader(token))
      .send({ listingId: ctx.annonce.id, content: 'Je souhaite un devis' });
    expect(resConv.status, resConv.text).toBe(201);
    await verifier('POST /conversations', resConv, CLES_ACHETEUR_TIERS);

    const resListConv = await api().get('/api/v2/conversations').set(authHeader(token));
    expect(resListConv.status, resListConv.text).toBe(200);
    await verifier('GET /conversations', resListConv, CLES_ACHETEUR_TIERS);

    const resMessages = await api().get(`/api/v2/conversations/${ctx.conversation.id}/messages`).set(authHeader(token));
    expect(resMessages.status, resMessages.text).toBe(200);
    await verifier('GET /conversations/:id/messages', resMessages, CLES_ACHETEUR_TIERS);

    const resMsg = await api()
      .post(`/api/v2/conversations/${ctx.conversation.id}/messages`)
      .set(authHeader(token))
      .send({ content: 'Merci pour le devis' });
    expect(resMsg.status, resMsg.text).toBe(201);
    await verifier('POST /conversations/:id/messages', resMsg, CLES_ACHETEUR_TIERS);

    // Commandes
    const resOrders = await api().get('/api/v2/orders').set(authHeader(token));
    expect(resOrders.status, resOrders.text).toBe(200);
    await verifier('GET /orders', resOrders, CLES_ACHETEUR_TIERS);

    const resOrder = await api().get(`/api/v2/orders/${ctx.orderId}`).set(authHeader(token));
    expect(resOrder.status, resOrder.text).toBe(200);
    await verifier('GET /orders/:id', resOrder, CLES_ACHETEUR_TIERS);

    // Confirm (déjà confirmé -> 409, la réponse ne doit rien fuiter)
    const resConfirm = await api()
      .post(`/api/v2/orders/${ctx.orderId}/confirm`)
      .set(authHeader(token));
    await verifier('POST /orders/:id/confirm', resConfirm, CLES_ACHETEUR_TIERS);

    // Cancel
    const resCancel = await api()
      .post(`/api/v2/orders/${ctx.orderId}/cancel`)
      .set(authHeader(token))
      .send({ reason: 'Test' });
    await verifier('POST /orders/:id/cancel', resCancel, CLES_ACHETEUR_TIERS);

    // Profil
    const resMe = await api().get('/api/v2/auth/me').set(authHeader(token));
    expect(resMe.status, resMe.text).toBe(200);
    await verifier('GET /auth/me', resMe, CLES_ACHETEUR);

    const resPatchMe = await api()
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ location: 'Rabat' });
    expect(resPatchMe.status, resPatchMe.text).toBe(200);
    await verifier('PATCH /auth/me', resPatchMe, CLES_ACHETEUR);

    const resAvatar = await api()
      .post('/api/v2/auth/me/avatar')
      .set(authHeader(token))
      .attach('avatar', FAKE_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(resAvatar.status, resAvatar.text).toBe(201);
    await verifier('POST /auth/me/avatar', resAvatar, CLES_ACHETEUR);

    const resProfile = await api()
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ buyerType: 'RETAILER' });
    expect(resProfile.status, resProfile.text).toBe(200);
    await verifier('PATCH /auth/me/profile', resProfile, CLES_ACHETEUR);

    // Comptes de paiement
    const resPayouts = await api().get('/api/v2/auth/me/payout-accounts').set(authHeader(token));
    expect(resPayouts.status, resPayouts.text).toBe(200);
    await verifier('GET /auth/me/payout-accounts', resPayouts, CLES_ACHETEUR);

    const resCreatePayout = await api()
      .post('/api/v2/auth/me/payout-accounts')
      .set(authHeader(token))
      .send({ method: 'CASH', accountNumber: '111122223333' });
    expect(resCreatePayout.status, resCreatePayout.text).toBe(201);
    await verifier('POST /auth/me/payout-accounts', resCreatePayout, CLES_ACHETEUR);

    const resPatchPayout = await api()
      .patch(`/api/v2/auth/me/payout-accounts/${ctx.payoutBuyer.id}`)
      .set(authHeader(token))
      .send({ accountName: 'Nouveau nom' });
    expect(resPatchPayout.status, resPatchPayout.text).toBe(200);
    await verifier('PATCH /auth/me/payout-accounts/:id', resPatchPayout, CLES_ACHETEUR);

    const resDeletePayout = await api()
      .delete(`/api/v2/auth/me/payout-accounts/${ctx.payoutBuyer.id}`)
      .set(authHeader(token));
    expect(resDeletePayout.status, resDeletePayout.text).toBe(204);
    await verifier('DELETE /auth/me/payout-accounts/:id', resDeletePayout, CLES_ACHETEUR);

    // Documents
    const resDoc = await api()
      .post('/api/v2/auth/me/documents')
      .set(authHeader(token))
      .attach('file', FAKE_JPEG, { filename: 'doc.jpg', contentType: 'image/jpeg' })
      .field('type', 'ID_CARD');
    expect(resDoc.status, resDoc.text).toBe(201);
    await verifier('POST /auth/me/documents', resDoc, CLES_ACHETEUR);

    const resDocs = await api().get('/api/v2/auth/me/documents').set(authHeader(token));
    expect(resDocs.status, resDocs.text).toBe(200);
    await verifier('GET /auth/me/documents', resDocs, CLES_ACHETEUR);

    // Parrainage
    const resReferral = await api().get('/api/v2/auth/me/referral').set(authHeader(token));
    expect(resReferral.status, resReferral.text).toBe(200);
    await verifier('GET /auth/me/referral', resReferral, CLES_ACHETEUR_TIERS);

    // Sessions
    const resSessions = await api().get('/api/v2/auth/sessions').set(authHeader(token));
    expect(resSessions.status, resSessions.text).toBe(200);
    await verifier('GET /auth/sessions', resSessions, CLES_ACHETEUR);

    const sessions = await prisma.session.findMany({ where: { userId: ctx.buyer.id } });
    const resDeleteSession = await api()
      .delete(`/api/v2/auth/sessions/${sessions[0].id}`)
      .set(authHeader(token));
    expect(resDeleteSession.status, resDeleteSession.text).toBe(204);
    await verifier('DELETE /auth/sessions/:id', resDeleteSession, CLES_ACHETEUR);

    const resLogoutAll = await api()
      .post('/api/v2/auth/logout-all')
      .set(authHeader(token));
    expect(resLogoutAll.status, resLogoutAll.text).toBe(204);
    await verifier('POST /auth/logout-all', resLogoutAll, CLES_ACHETEUR);
  });
});

describe('Confidentialité — fournisseur', () => {
  it('aucun identifiant ni nom d\'acheteur ne fuite sur aucune route fournisseur', async () => {
    const ctx = await scenarioComplet();
    const token = tokenPour(ctx.supplierUser, 'SUPPLIER');

    // Lots
    const resCreateLot = await api()
      .post('/api/v2/supplier/lots')
      .set(authHeader(token))
      .send({
        productId: ctx.product.id,
        zoneId: ctx.zoneLot.id,
        agreedUnitPrice: 1500,
        quantity: 20,
        storageType: 'SUPPLIER_SITE',
        pickupAddress: '5 rue test',
        pickupLatitude: 10,
        pickupLongitude: 20,
      });
    expect(resCreateLot.status, resCreateLot.text).toBe(201);
    await verifier('POST /supplier/lots', resCreateLot, CLES_FOURNISSEUR_TIERS);

    const resLots = await api().get('/api/v2/supplier/lots').set(authHeader(token));
    expect(resLots.status, resLots.text).toBe(200);
    await verifier('GET /supplier/lots', resLots, CLES_FOURNISSEUR_TIERS);

    const resLot = await api().get(`/api/v2/supplier/lots/${ctx.lot.id}`).set(authHeader(token));
    expect(resLot.status, resLot.text).toBe(200);
    await verifier('GET /supplier/lots/:id', resLot, CLES_FOURNISSEUR_TIERS);

    // Update (lot AVAILABLE -> 409, la réponse ne doit rien fuiter)
    const resUpdateLot = await api()
      .patch(`/api/v2/supplier/lots/${ctx.lot.id}`)
      .set(authHeader(token))
      .send({ agreedUnitPrice: 1100 });
    await verifier('PATCH /supplier/lots/:id', resUpdateLot, CLES_FOURNISSEUR_TIERS);

    // Delete (lot AVAILABLE -> 409)
    const resDeleteLot = await api()
      .delete(`/api/v2/supplier/lots/${ctx.lot.id}`)
      .set(authHeader(token));
    await verifier('DELETE /supplier/lots/:id', resDeleteLot, CLES_FOURNISSEUR_TIERS);

    // Withdraw (quantityReserved > 0 -> 409)
    const resWithdraw = await api()
      .post(`/api/v2/supplier/lots/${ctx.lot.id}/withdraw`)
      .set(authHeader(token))
      .send({ reason: 'Test' });
    await verifier('POST /supplier/lots/:id/withdraw', resWithdraw, CLES_FOURNISSEUR_TIERS);

    // Reversements + compensations
    const resPayouts = await api().get('/api/v2/supplier/payouts').set(authHeader(token));
    expect(resPayouts.status, resPayouts.text).toBe(200);
    await verifier('GET /supplier/payouts', resPayouts, CLES_FOURNISSEUR_TIERS);

    const resCompensations = await api().get('/api/v2/supplier/compensations').set(authHeader(token));
    expect(resCompensations.status, resCompensations.text).toBe(200);
    await verifier('GET /supplier/compensations', resCompensations, CLES_FOURNISSEUR_TIERS);

    // Profil
    const resMe = await api().get('/api/v2/auth/me').set(authHeader(token));
    expect(resMe.status, resMe.text).toBe(200);
    await verifier('GET /auth/me', resMe, CLES_FOURNISSEUR);

    const resPatchMe = await api()
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ location: 'Casablanca' });
    expect(resPatchMe.status, resPatchMe.text).toBe(200);
    await verifier('PATCH /auth/me', resPatchMe, CLES_FOURNISSEUR);

    const resAvatar = await api()
      .post('/api/v2/auth/me/avatar')
      .set(authHeader(token))
      .attach('avatar', FAKE_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(resAvatar.status, resAvatar.text).toBe(201);
    await verifier('POST /auth/me/avatar', resAvatar, CLES_FOURNISSEUR);

    const resProfile = await api()
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ farmName: 'Nouvelle Ferme' });
    expect(resProfile.status, resProfile.text).toBe(200);
    await verifier('PATCH /auth/me/profile', resProfile, CLES_FOURNISSEUR);

    // Comptes de paiement
    const resPayouts2 = await api().get('/api/v2/auth/me/payout-accounts').set(authHeader(token));
    expect(resPayouts2.status, resPayouts2.text).toBe(200);
    await verifier('GET /auth/me/payout-accounts', resPayouts2, CLES_FOURNISSEUR);

    const resCreatePayout = await api()
      .post('/api/v2/auth/me/payout-accounts')
      .set(authHeader(token))
      .send({ method: 'CASH', accountNumber: '444455556666' });
    expect(resCreatePayout.status, resCreatePayout.text).toBe(201);
    await verifier('POST /auth/me/payout-accounts', resCreatePayout, CLES_FOURNISSEUR);

    const resPatchPayout = await api()
      .patch(`/api/v2/auth/me/payout-accounts/${ctx.payoutSupplier.id}`)
      .set(authHeader(token))
      .send({ accountName: 'Nouveau nom' });
    expect(resPatchPayout.status, resPatchPayout.text).toBe(200);
    await verifier('PATCH /auth/me/payout-accounts/:id', resPatchPayout, CLES_FOURNISSEUR);

    const resDeletePayout = await api()
      .delete(`/api/v2/auth/me/payout-accounts/${ctx.payoutSupplier.id}`)
      .set(authHeader(token));
    expect(resDeletePayout.status, resDeletePayout.text).toBe(204);
    await verifier('DELETE /auth/me/payout-accounts/:id', resDeletePayout, CLES_FOURNISSEUR);

    // Documents
    const resDoc = await api()
      .post('/api/v2/auth/me/documents')
      .set(authHeader(token))
      .attach('file', FAKE_JPEG, { filename: 'doc.jpg', contentType: 'image/jpeg' })
      .field('type', 'FARM_PROOF');
    expect(resDoc.status, resDoc.text).toBe(201);
    await verifier('POST /auth/me/documents', resDoc, CLES_FOURNISSEUR);

    const resDocs = await api().get('/api/v2/auth/me/documents').set(authHeader(token));
    expect(resDocs.status, resDocs.text).toBe(200);
    await verifier('GET /auth/me/documents', resDocs, CLES_FOURNISSEUR);

    // Parrainage
    const resReferral = await api().get('/api/v2/auth/me/referral').set(authHeader(token));
    expect(resReferral.status, resReferral.text).toBe(200);
    await verifier('GET /auth/me/referral', resReferral, CLES_FOURNISSEUR_TIERS);

    // Sessions
    const resSessions = await api().get('/api/v2/auth/sessions').set(authHeader(token));
    expect(resSessions.status, resSessions.text).toBe(200);
    await verifier('GET /auth/sessions', resSessions, CLES_FOURNISSEUR);

    const sessions = await prisma.session.findMany({ where: { userId: ctx.supplierUser.id } });
    const resDeleteSession = await api()
      .delete(`/api/v2/auth/sessions/${sessions[0].id}`)
      .set(authHeader(token));
    expect(resDeleteSession.status, resDeleteSession.text).toBe(204);
    await verifier('DELETE /auth/sessions/:id', resDeleteSession, CLES_FOURNISSEUR);

    const resLogoutAll = await api()
      .post('/api/v2/auth/logout-all')
      .set(authHeader(token));
    expect(resLogoutAll.status, resLogoutAll.text).toBe(204);
    await verifier('POST /auth/logout-all', resLogoutAll, CLES_FOURNISSEUR);
  });
});

describe('Confidentialité — livreur', () => {
  it('aucun montant ni prix ne fuite sur aucune route livreur', async () => {
    const ctx = await scenarioComplet();
    const token = tokenPour(ctx.driverUser, 'DRIVER');

    // Livraisons
    const resAvailable = await api().get('/api/v2/driver/deliveries/available').set(authHeader(token));
    expect(resAvailable.status, resAvailable.text).toBe(200);
    await verifier('GET /driver/deliveries/available', resAvailable, CLES_LIVREUR);

    const resMine = await api().get('/api/v2/driver/deliveries/mine').set(authHeader(token));
    expect(resMine.status, resMine.text).toBe(200);
    await verifier('GET /driver/deliveries/mine', resMine, CLES_LIVREUR);

    // Accept (déjà acceptée -> 409, la réponse ne doit rien fuiter)
    const resAccept = await api()
      .post(`/api/v2/driver/deliveries/${ctx.deliveryId}/accept`)
      .set(authHeader(token));
    await verifier('POST /driver/deliveries/:id/accept', resAccept, CLES_LIVREUR);

    // Status (ACCEPTED -> PICKED_UP -> IN_TRANSIT : transitions autorisées)
    const resPickedUp = await api()
      .patch(`/api/v2/driver/deliveries/${ctx.deliveryId}/status`)
      .set(authHeader(token))
      .send({ status: 'PICKED_UP' });
    expect(resPickedUp.status, resPickedUp.text).toBe(200);
    await verifier('PATCH /driver/deliveries/:id/status (PICKED_UP)', resPickedUp, CLES_LIVREUR);

    const resStatus = await api()
      .patch(`/api/v2/driver/deliveries/${ctx.deliveryId}/status`)
      .set(authHeader(token))
      .send({ status: 'IN_TRANSIT' });
    expect(resStatus.status, resStatus.text).toBe(200);
    await verifier('PATCH /driver/deliveries/:id/status (IN_TRANSIT)', resStatus, CLES_LIVREUR);

    // Profil
    const resMe = await api().get('/api/v2/auth/me').set(authHeader(token));
    expect(resMe.status, resMe.text).toBe(200);
    await verifier('GET /auth/me', resMe, CLES_LIVREUR);

    const resPatchMe = await api()
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ location: 'Marrakech' });
    expect(resPatchMe.status, resPatchMe.text).toBe(200);
    await verifier('PATCH /auth/me', resPatchMe, CLES_LIVREUR);

    const resAvatar = await api()
      .post('/api/v2/auth/me/avatar')
      .set(authHeader(token))
      .attach('avatar', FAKE_JPEG, { filename: 'avatar.jpg', contentType: 'image/jpeg' });
    expect(resAvatar.status, resAvatar.text).toBe(201);
    await verifier('POST /auth/me/avatar', resAvatar, CLES_LIVREUR);

    const resProfile = await api()
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ vehicleType: 'Camion' });
    expect(resProfile.status, resProfile.text).toBe(200);
    await verifier('PATCH /auth/me/profile', resProfile, CLES_LIVREUR);

    // Parrainage
    const resReferral = await api().get('/api/v2/auth/me/referral').set(authHeader(token));
    expect(resReferral.status, resReferral.text).toBe(200);
    await verifier('GET /auth/me/referral', resReferral, CLES_LIVREUR);

    // Sessions
    const resSessions = await api().get('/api/v2/auth/sessions').set(authHeader(token));
    expect(resSessions.status, resSessions.text).toBe(200);
    await verifier('GET /auth/sessions', resSessions, CLES_LIVREUR);

    const sessions = await prisma.session.findMany({ where: { userId: ctx.driverUser.id } });
    const resDeleteSession = await api()
      .delete(`/api/v2/auth/sessions/${sessions[0].id}`)
      .set(authHeader(token));
    expect(resDeleteSession.status, resDeleteSession.text).toBe(204);
    await verifier('DELETE /auth/sessions/:id', resDeleteSession, CLES_LIVREUR);

    const resLogoutAll = await api()
      .post('/api/v2/auth/logout-all')
      .set(authHeader(token));
    expect(resLogoutAll.status, resLogoutAll.text).toBe(204);
    await verifier('POST /auth/logout-all', resLogoutAll, CLES_LIVREUR);
  });
});
