import { randomInt } from 'node:crypto';
import prisma from '../../config/prisma.js';
import { uploadBufferToCloudinary } from '../../utils/cloudinaryUpload.js';
import { getLookupId } from '../../utils/lookupCache.js';
import { asMoney, toDecimal, toNumber } from '../../utils/money.js';
import { listingToStaffDto } from '../../utils/dto/listing.dto.js';
import { recordAudit } from '../../utils/audit.js';
import { LISTING_STATUSES } from '../../validators/listing.validator.js';

// Résout l'identité de l'acteur pour l'audit (recordAudit attend des objets).
// Un agent connecté a req.agent (requireCapability) ; un admin n'en a pas.
function acteur(req) {
  return {
    actorUser: req.user,
    actorAgent: req.agent ?? null,
  };
}

// Le DTO staff a besoin du lot avec son produit, sa zone, ses photos et
// l'identité du fournisseur (lotToStaffDto s'occupe de la forme).
const LOT_STAFF_INCLUDE = {
  product: { include: { category: true, unit: true } },
  zone: true,
  hub: true,
  media: true,
  supplier: { include: { user: { select: { profileVerificationStatus: true } } } },
};

// Toutes les lectures d'annonce passent par cet include : le DTO staff a
// besoin du statut, du produit, de la zone, des photos et du lot.
const LISTING_STAFF_INCLUDE = {
  status: true,
  product: { include: { category: true, unit: true } },
  zone: true,
  media: true,
  lots: { include: { lot: { include: LOT_STAFF_INCLUDE } } },
};

// Statuts qui autorisent la modification d'une annonce : une annonce SOLD est
// figée, son historique doit rester lisible tel quel.
const STATUTS_MODIFIABLES = ['DRAFT', 'ACTIVE', 'INACTIVE'];

// Vérifie que le lot peut porter une annonce : AVAILABLE avec du stock. Une
// annonce sans stock à vendre n'a aucun sens public.
function lotDisponible(lot) {
  return lot.status === 'AVAILABLE' && toNumber(lot.quantityAvailable) > 0;
}

// POST /api/v2/staff/listings — création d'une annonce à partir d'un lot.
// L'annonce est la SEULE chose que voient les acheteurs : le lot reste interne.
export const createListing = async (req, res) => {
  const { lotIds, title, description, unitPrice, zoneId } = req.body;

  // AU MVP une annonce = exactement un lot (C7) : la table ListingLot permet
  // d'en agréger plusieurs plus tard sans migration.
  if (!Array.isArray(lotIds) || lotIds.length !== 1) {
    return res.status(400).json({ error: 'Une annonce correspond à un seul lot' });
  }
  const lotId = lotIds[0];

  const lot = await prisma.stockLot.findUnique({ where: { id: lotId } });
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }
  if (!lotDisponible(lot)) {
    return res.status(409).json({
      error: 'Le lot doit être disponible avec du stock',
      code: 'LOT_NOT_AVAILABLE',
    });
  }

  // Un lot déjà relié à une annonce (quel que soit son statut) ne peut pas
  // l'être une seconde fois : on réutilise publish / unpublish.
  const existant = await prisma.listingLot.findFirst({ where: { lotId } });
  if (existant) {
    return res.status(409).json({
      error: 'Lot déjà relié à une annonce',
      code: 'LOT_ALREADY_LINKED',
    });
  }

  const files = req.files ?? [];

  // Ces vérifications touchent la base : une valeur inconnue vaut une requête
  // mal formée, refusée ici plutôt qu'une erreur serveur de clé étrangère.
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

  // La création tient en une transaction. La reference dépend de l'id
  // auto-incrémenté : l'annonce est créée avec une référence provisoire, puis
  // mise à jour — comme lotCode sur un lot.
  const statutBrouillonId = await getLookupId('listingStatus', 'DRAFT');

  const annonce = await prisma.$transaction(async (tx) => {
    const cree = await tx.listing.create({
      data: {
        reference: `ANN-TMP-${Date.now()}-${randomInt(0, 1_000_000)}`,
        title,
        description: description ?? null,
        // Prix public : celui de l'équipe, par défaut le prix convenu du lot.
        unitPrice: asMoney(unitPrice ?? lot.agreedUnitPrice),
        // Le produit et la zone sont repris du lot : le client ne les choisit
        // pas, l'annonce expose le produit du lot, jamais un lot directement.
        productId: lot.productId,
        zoneId: zoneId ?? lot.zoneId,
        statusId: statutBrouillonId,
        createdByUserId: req.user.id,
        createdByAgentId: req.agent?.id ?? null,
      },
    });

    const reference = `ANN-${String(cree.id).padStart(6, '0')}`;
    const misAJour = await tx.listing.update({
      where: { id: cree.id },
      data: { reference },
    });

    await tx.listingLot.create({
      data: { listingId: cree.id, lotId: lot.id },
    });

    // Photos : celles envoyées ; sinon copie des photos du lot (nouvelles
    // lignes Media ownerListingId reprenant url et publicId, isPrivate false).
    if (files.length > 0) {
      // withPublicId : la ligne Media de l'annonce reprend le public_id, comme
      // elle le fait pour les photos copiées depuis le lot.
      const optionsUpload = { folder: 'agriconnect/listings', withPublicId: true, userId: req.user.id };
      for (let i = 0; i < files.length; i++) {
        const { url, public_id } = await uploadBufferToCloudinary(files[i].buffer, {
          ...optionsUpload,
          mimetype: files[i].mimetype,
        });
        await tx.media.create({
          data: {
            ownerListingId: cree.id,
            mediaTypeId,
            mimeTypeId: mimeTypeIdParCode.get(files[i].mimetype),
            url,
            publicId: public_id,
            isPrivate: false,
            isPrimary: i === 0,
            position: i,
          },
        });
      }
    } else {
      const photosLot = await tx.media.findMany({
        where: { ownerLotId: lot.id },
        orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
      });
      for (const photo of photosLot) {
        await tx.media.create({
          data: {
            ownerListingId: cree.id,
            mediaTypeId: photo.mediaTypeId,
            mimeTypeId: photo.mimeTypeId,
            url: photo.url,
            publicId: photo.publicId,
            isPrivate: false,
            isPrimary: photo.isPrimary,
            position: photo.position,
          },
        });
      }
    }

    await recordAudit(tx, {
      ...acteur(req),
      action: 'LISTING_CREATED',
      entityType: 'Listing',
      entityId: cree.id,
      metadata: { lotId: lot.id, reference },
    });

    return misAJour;
  });

  const complet = await prisma.listing.findUnique({
    where: { id: annonce.id },
    include: LISTING_STAFF_INCLUDE,
  });

  res.status(201).json(listingToStaffDto(complet));
};

// PATCH /api/v2/staff/listings/:id — titre, description, prix public, zone.
export const updateListing = async (req, res) => {
  const { title, description, unitPrice, zoneId } = req.body;

  const annonce = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: { status: true },
  });

  if (!annonce) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (!STATUTS_MODIFIABLES.includes(annonce.status.code)) {
    throw Object.assign(
      new Error(`Une annonce ${annonce.status.code} ne peut pas être modifiée`),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }

  const misAJour = await prisma.$transaction(async (tx) => {
    const maj = await tx.listing.update({
      where: { id: annonce.id },
      data: {
        title: title ?? undefined,
        description: description ?? undefined,
        unitPrice: unitPrice !== undefined ? asMoney(unitPrice) : undefined,
        zoneId: zoneId ?? undefined,
      },
      include: LISTING_STAFF_INCLUDE,
    });
    // Tout changement de prix public est tracé : c'est ainsi que les prix
    // sont contrôlés — seule l'équipe fixe le prix public.
    if (
      unitPrice !== undefined &&
      !asMoney(unitPrice).equals(toDecimal(annonce.unitPrice))
    ) {
      await recordAudit(tx, {
        ...acteur(req),
        action: 'LISTING_PRICE_UPDATED',
        entityType: 'Listing',
        entityId: annonce.id,
        metadata: {
          oldUnitPrice: toNumber(annonce.unitPrice),
          newUnitPrice: asMoney(unitPrice).toNumber(),
        },
      });
    }
    return maj;
  });

  res.json(listingToStaffDto(misAJour));
};

// POST /api/v2/staff/listings/:id/publish — DRAFT ou INACTIVE -> ACTIVE.
export const publishListing = async (req, res) => {
  const annonce = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: { status: true, lots: { include: { lot: true } } },
  });

  if (!annonce) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (!['DRAFT', 'INACTIVE'].includes(annonce.status.code)) {
    throw Object.assign(
      new Error(`Une annonce ${annonce.status.code} ne peut pas être publiée`),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }

  // On ne publie pas une annonce qui n'a plus rien à vendre : le lot doit
  // être AVAILABLE avec du stock.
  const lot = annonce.lots?.[0]?.lot;
  if (!lot || !lotDisponible(lot)) {
    return res.status(409).json({
      error: 'Le lot doit être disponible avec du stock',
      code: 'LOT_NOT_AVAILABLE',
    });
  }

  const statutActifId = await getLookupId('listingStatus', 'ACTIVE');

  const misAJour = await prisma.$transaction(async (tx) => {
    const maj = await tx.listing.update({
      where: { id: annonce.id },
      data: { statusId: statutActifId, publishedAt: new Date() },
      include: LISTING_STAFF_INCLUDE,
    });
    await recordAudit(tx, {
      ...acteur(req),
      action: 'LISTING_PUBLISHED',
      entityType: 'Listing',
      entityId: annonce.id,
    });
    return maj;
  });

  res.json(listingToStaffDto(misAJour));
};

// POST /api/v2/staff/listings/:id/unpublish — ACTIVE -> INACTIVE.
export const unpublishListing = async (req, res) => {
  const annonce = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: { status: true },
  });

  if (!annonce) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (annonce.status.code !== 'ACTIVE') {
    throw Object.assign(
      new Error('Seule une annonce ACTIVE peut être dépubliée'),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }

  const statutInactifId = await getLookupId('listingStatus', 'INACTIVE');

  const misAJour = await prisma.$transaction(async (tx) => {
    const maj = await tx.listing.update({
      where: { id: annonce.id },
      data: { statusId: statutInactifId },
      include: LISTING_STAFF_INCLUDE,
    });
    await recordAudit(tx, {
      ...acteur(req),
      action: 'LISTING_UNPUBLISHED',
      entityType: 'Listing',
      entityId: annonce.id,
    });
    return maj;
  });

  res.json(listingToStaffDto(misAJour));
};

// GET /api/v2/staff/listings?status=&productId=&supplierId=
export const listListings = async (req, res) => {
  const { status, productId, supplierId } = req.query;
  if (status && !LISTING_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = {};
  if (status) {
    const statut = await prisma.listingStatus.findUnique({ where: { code: status } });
    where.statusId = statut.id;
  }
  if (productId) where.productId = Number(productId);
  if (supplierId) {
    // Le promoteur n'existe pas sur l'annonce : il passe par le lot relié.
    where.lots = { some: { lot: { supplierId: Number(supplierId) } } };
  }

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: LISTING_STAFF_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.listing.count({ where }),
  ]);

  res.json({ items: items.map(listingToStaffDto), page, limit, total });
};

// GET /api/v2/staff/listings/:id
export const getListing = async (req, res) => {
  const annonce = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: LISTING_STAFF_INCLUDE,
  });

  if (!annonce) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  res.json(listingToStaffDto(annonce));
};
