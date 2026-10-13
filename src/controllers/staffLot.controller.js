import { randomInt } from 'node:crypto';
import prisma from '../config/prisma.js';
import { uploadBufferToCloudinary } from '../utils/cloudinaryUpload.js';
import { getLookupId } from '../utils/lookupCache.js';
import { asMoney, asQuantity, toNumber } from '../utils/money.js';
import { lotToStaffDto } from '../utils/dto/lot.dto.js';
import { recordAudit } from '../utils/audit.js';
import { receiveLot, returnAvailable } from '../services/stock.service.js';
import { assertTransition } from '../services/lot.state.js';

// Un lot appartient à un SupplierProfile, pas directement à un User. Pour
// créer au nom d'un fournisseur, on résout d'abord supplierUserId vers son
// profil : un compte SUPPLIER sans profil est un compte malformé.
async function profilFournisseurDepuisUserId(userId) {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId } });
  if (!profile) {
    throw Object.assign(new Error('Profil fournisseur introuvable'), { statusCode: 400 });
  }
  return profile;
}

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un agent connecté a req.agent (requireCapability) ; un admin n'en a pas.
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: req.agent ?? null,
  };
}

// Résout l'identité de l'acteur pour les services de stock (format numérique).
function acteurStock(req) {
  return {
    actorUserId: req.user.id,
    actorAgentId: req.agent?.id ?? null,
  };
}

// Toutes les lectures de lot passent par cet include : le DTO staff a besoin
// du produit, de la zone, du hub, des photos et de l'identité du fournisseur
// (avec profileVerificationStatus pour la validation).
const LOT_STAFF_INCLUDE = {
  product: { include: { category: true, unit: true } },
  zone: true,
  hub: true,
  media: true,
  supplier: { include: { user: { select: { profileVerificationStatus: true } } } },
};

// POST /api/v2/staff/lots — création d'un lot au nom d'un fournisseur.
// Mêmes champs que la création fournisseur (P2.2) + supplierUserId.
// createdByAgentId = req.agent.id si l'acteur est un agent.
export const createLot = async (req, res) => {
  const profile = await profilFournisseurDepuisUserId(Number(req.body.supplierUserId));
  const {
    productId,
    zoneId,
    agreedUnitPrice,
    quantity,
    storageType,
    hubId,
    pickupAddress,
    pickupLatitude,
    pickupLongitude,
    expiresAt,
    harvestedAt,
    packagingNote,
    qualityNote,
  } = req.body;

  // Ces vérifications touchent la base : une valeur inconnue vaut une requête
  // mal formée, refusée ici plutôt qu'une erreur serveur de clé étrangère.
  const [product, zone] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      include: { category: true, unit: true },
    }),
    prisma.zone.findUnique({ where: { id: zoneId } }),
  ]);
  if (!product) {
    return res.status(400).json({ error: 'Produit introuvable' });
  }
  if (!zone) {
    return res.status(400).json({ error: 'Zone introuvable' });
  }

  // Un lot HUB n'existe que s'il peut être déposé : le point de dépôt doit
  // exister, être actif et accepter la dépose.
  if (storageType === 'HUB') {
    const hub = await prisma.hub.findUnique({ where: { id: hubId } });
    if (!hub || !hub.isActive) {
      return res.status(400).json({ error: 'Point de dépôt introuvable ou inactif' });
    }
    if (!hub.acceptsDropoff) {
      return res.status(400).json({ error: "Ce point de dépôt n'accepte pas la dépose" });
    }
  }

  // Un produit périssable ne peut pas être consigné sans date de péremption.
  if (product.isPerishable && !expiresAt) {
    return res.status(400).json({ error: "Date d'expiration requise pour un produit périssable" });
  }

  const files = req.files ?? [];

  const mediaTypeId = await getLookupId('mediaType', 'IMAGE');
  const mimeTypes = await prisma.mimeType.findMany({
    where: { code: { in: [...new Set(files.map((f) => f.mimetype))] } },
  });
  const mimeTypeIdParCode = new Map(mimeTypes.map((m) => [m.code, m.id]));
  for (const file of files) {
    if (!mimeTypeIdParCode.has(file.mimetype)) {
      return res.status(400).json({ error: `Type de fichier non supporté : ${file.mimetype}` });
    }
  }

  // La création tient en une transaction. Le lotCode dépend de l'id
  // auto-incrémenté : le lot est créé avec un code provisoire, puis mis à jour.
  const lot = await prisma.$transaction(async (tx) => {
    const cree = await tx.stockLot.create({
      data: {
        lotCode: `LOT-TMP-${Date.now()}-${randomInt(0, 1_000_000)}`,
        supplierId: profile.id,
        productId,
        zoneId,
        storageType,
        hubId: storageType === 'HUB' ? hubId : null,
        pickupAddress: storageType === 'SUPPLIER_SITE' ? pickupAddress : null,
        pickupLatitude: storageType === 'SUPPLIER_SITE' ? pickupLatitude : null,
        pickupLongitude: storageType === 'SUPPLIER_SITE' ? pickupLongitude : null,
        agreedUnitPrice: asMoney(agreedUnitPrice),
        quantityInitial: asQuantity(quantity),
        quantityAvailable: asQuantity(quantity),
        status: 'PENDING_VALIDATION',
        createdByAgentId: req.agent?.id ?? null,
        harvestedAt: harvestedAt ? new Date(harvestedAt) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        packagingNote: packagingNote ?? null,
        qualityNote: qualityNote ?? null,
      },
    });

    const lotCode = `LOT-${String(cree.id).padStart(6, '0')}`;
    const misAJour = await tx.stockLot.update({
      where: { id: cree.id },
      data: { lotCode },
    });

    for (let i = 0; i < files.length; i++) {
      const url = await uploadBufferToCloudinary(files[i].buffer, { folder: 'agriconnect/lots' });
      await tx.media.create({
        data: {
          ownerLotId: misAJour.id,
          mediaTypeId,
          mimeTypeId: mimeTypeIdParCode.get(files[i].mimetype),
          url,
          isPrimary: i === 0,
          position: i,
        },
      });
    }

    return misAJour;
  });

  const complet = await prisma.stockLot.findUnique({
    where: { id: lot.id },
    include: LOT_STAFF_INCLUDE,
  });

  res.status(201).json(lotToStaffDto(complet));
};

// GET /api/v2/staff/lots?status=&supplierId=&productId=
export const listLots = async (req, res) => {
  const { status, supplierId, productId } = req.query;
  if (status) {
    const statutsValides = ['PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED', 'SOLD_OUT', 'EXPIRED', 'RETURNED', 'REJECTED', 'WITHDRAWN'];
    if (!statutsValides.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = {};
  if (status) where.status = status;
  if (supplierId) where.supplierId = Number(supplierId);
  if (productId) where.productId = Number(productId);

  const [items, total] = await Promise.all([
    prisma.stockLot.findMany({
      where,
      include: LOT_STAFF_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockLot.count({ where }),
  ]);

  res.json({ items: items.map(lotToStaffDto), page, limit, total });
};

// GET /api/v2/staff/lots/:id
export const getLot = async (req, res) => {
  const lot = await prisma.stockLot.findUnique({
    where: { id: req.params.id },
    include: LOT_STAFF_INCLUDE,
  });

  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }

  res.json(lotToStaffDto(lot));
};

// POST /api/v2/staff/lots/:id/validate
export const validateLot = async (req, res) => {
  const lot = await prisma.stockLot.findUnique({
    where: { id: req.params.id },
    include: { supplier: { include: { user: true } } },
  });

  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }

  // Le fournisseur doit avoir un profil vérifié pour que son lot soit validé.
  const statutFournisseur = lot.supplier.user.profileVerificationStatus;
  if (statutFournisseur !== 'VERIFIED') {
    return res.status(409).json({
      error: 'Le fournisseur doit avoir un profil vérifié',
      code: 'NOT_VERIFIED',
    });
  }

  assertTransition(lot.status, 'AVAILABLE');

  const ctx = acteurStock(req);

  const misAJour = await prisma.$transaction(async (tx) => {
    await receiveLot(tx, lot.id, ctx);
    const maj = await tx.stockLot.update({
      where: { id: lot.id },
      data: {
        validatedAt: new Date(),
        validatedByAgentId: req.agent?.id ?? null,
      },
      include: LOT_STAFF_INCLUDE,
    });
    await recordAudit(tx, {
      ...acteur(req),
      action: 'LOT_VALIDATED',
      entityType: 'StockLot',
      entityId: lot.id,
    });
    return maj;
  });

  res.json(lotToStaffDto(misAJour));
};

// POST /api/v2/staff/lots/:id/reject
export const rejectLot = async (req, res) => {
  const { reason } = req.body;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ error: 'La raison du rejet est requise' });
  }

  const lot = await prisma.stockLot.findUnique({ where: { id: req.params.id } });
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }

  assertTransition(lot.status, 'REJECTED');

  const actor = acteur(req);

  const misAJour = await prisma.$transaction(async (tx) => {
    const maj = await tx.stockLot.update({
      where: { id: lot.id },
      data: { status: 'REJECTED', rejectionReason: reason.trim() },
      include: LOT_STAFF_INCLUDE,
    });
    await recordAudit(tx, {
      ...acteur(req),
      action: 'LOT_REJECTED',
      entityType: 'StockLot',
      entityId: lot.id,
      metadata: { reason: reason.trim() },
    });
    return maj;
  });

  res.json(lotToStaffDto(misAJour));
};

// POST /api/v2/staff/lots/:id/return
export const returnLot = async (req, res) => {
  const { reason } = req.body;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ error: 'La raison du retour est requise' });
  }

  const lot = await prisma.stockLot.findUnique({ where: { id: req.params.id } });
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }

  // Un retour n'est possible que sur un lot AVAILABLE ou FULLY_RESERVED sans
  // réservation (quantityReserved = 0) : sinon il faut d'abord libérer les
  // réservations.
  const peutRetourner =
    lot.status === 'AVAILABLE' ||
    (lot.status === 'FULLY_RESERVED' && toNumber(lot.quantityReserved) === 0);
  if (!peutRetourner) {
    throw Object.assign(
      new Error('Seul un lot disponible ou entièrement réservé sans réservation peut être retourné'),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }

  assertTransition(lot.status, 'RETURNED');

  const ctx = acteurStock(req);
  const quantite = lot.quantityAvailable;

  const misAJour = await prisma.$transaction(async (tx) => {
    const maj = await returnAvailable(tx, lot.id, quantite, ctx, 'RETURNED');
    await recordAudit(tx, {
      ...acteur(req),
      action: 'LOT_RETURNED',
      entityType: 'StockLot',
      entityId: lot.id,
      metadata: { reason: reason.trim(), quantity: toNumber(quantite) },
    });
    return maj;
  });

  const complet = await prisma.stockLot.findUnique({
    where: { id: lot.id },
    include: LOT_STAFF_INCLUDE,
  });

  res.json(lotToStaffDto(complet));
};

// GET /api/v2/staff/stock-movements?lotId=
export const listStockMovements = async (req, res) => {
  const { lotId } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = lotId ? { lotId: Number(lotId) } : {};

  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockMovement.count({ where }),
  ]);

  res.json({ items, page, limit, total });
};

// POST /api/v2/staff/lots/:id/quality-checks
export const createQualityCheck = async (req, res) => {
  const { grade, notes } = req.body;
  if (!['A', 'B', 'C'].includes(grade)) {
    return res.status(400).json({ error: 'La note doit être A, B ou C' });
  }

  const lot = await prisma.stockLot.findUnique({ where: { id: req.params.id } });
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }

  const statutsAutorises = ['PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED'];
  if (!statutsAutorises.includes(lot.status)) {
    throw Object.assign(
      new Error('Seul un lot en attente de validation, disponible ou entièrement réservé peut être inspecté'),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }

  const actor = acteur(req);

  const misAJour = await prisma.$transaction(async (tx) => {
    await tx.lotQualityCheck.create({
      data: {
        lotId: lot.id,
        grade,
        notes: notes ?? null,
        inspectedByUserId: req.user.id,
        inspectedByAgentId: req.agent?.id ?? null,
      },
    });
    // La dernière note devient la note courante du lot : elle sert de
    // résumé rapide dans les listes staff et le catalogue acheteur (P2.6).
    const maj = await tx.stockLot.update({
      where: { id: lot.id },
      data: { qualityGrade: grade },
      include: LOT_STAFF_INCLUDE,
    });
    await recordAudit(tx, {
      ...acteur(req),
      action: 'LOT_QUALITY_CHECKED',
      entityType: 'StockLot',
      entityId: lot.id,
      metadata: { grade, notes: notes ?? null },
    });
    return maj;
  });

  res.status(201).json(lotToStaffDto(misAJour));
};

// GET /api/v2/staff/lots/:id/quality-checks
export const listQualityChecks = async (req, res) => {
  const checks = await prisma.lotQualityCheck.findMany({
    where: { lotId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });

  res.json(checks);
};
