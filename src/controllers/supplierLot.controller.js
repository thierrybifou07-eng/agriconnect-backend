import { randomInt } from 'node:crypto';
import prisma from '../config/prisma.js';
import { uploadBufferToCloudinary } from '../utils/cloudinaryUpload.js';
import { getLookupId } from '../utils/lookupCache.js';
import { asMoney, asQuantity } from '../utils/money.js';
import { lotToSupplierDto } from '../utils/dto/lot.dto.js';
import { LOT_STATUSES } from '../validators/lot.validator.js';

// Un lot ne peut être modifié ou supprimé que tant qu'il n'a pas été validé :
// une fois l'équipe passée, les quantités sont pilotées par les mouvements de
// stock (P2.3) et une écriture directe déréglerait le décompte.
const STATUTS_MODIFIABLES = ['PENDING_VALIDATION'];
// REJECTED est aussi supprimable : un lot rejeté n'a jamais été réceptionné,
// donc aucun mouvement de stock n'existe à annuler.
const STATUTS_SUPPRIMABLES = ['PENDING_VALIDATION', 'REJECTED'];

// Toutes les lectures de lot passent par cet include : le DTO a besoin du
// produit (avec catégorie et unité), de la zone, du hub éventuel et des
// photos. Aucun appel ne les recharge ensuite séparément.
const LOT_INCLUDE = {
  product: { include: { category: true, unit: true } },
  zone: true,
  hub: true,
  media: true,
};

// Le lot appartient à un SupplierProfile, pas directement à un User : le
// profil est la clé de tout ce que le fournisseur peut déclarer. Un compte
// SUPPLIER sans profil est un compte malformé (l'inscription le crée, P1.2) :
// on refuse avant toute requête plutôt que de laisser une contrainte de base
// répondre 500.
async function profilFournisseur(userId) {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId } });
  if (!profile) {
    throw Object.assign(new Error('Profil fournisseur introuvable'), { statusCode: 400 });
  }
  return profile;
}

// POST /api/v2/supplier/lots
export const createLot = async (req, res) => {
  const profile = await profilFournisseur(req.user.id);
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
  // mal formée, refusée ici plutôt qu'une erreur serveur de clé étrangère plus
  // loin.
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

  // Un produit périssable ne peut pas être consigné sans date de péremption :
  // c'est elle qui pilote l'expiration automatique du stock (P2.3).
  if (product.isPerishable && !expiresAt) {
    return res.status(400).json({ error: "Date d'expiration requise pour un produit périssable" });
  }

  const files = req.files ?? [];

  // Les types mime acceptés par le middleware (jpeg, png, webp) sont tous
  // seedés dans MimeType : la lecture évite une erreur de clé étrangère si la
  // table de référence n'était pas peuplée.
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
  // auto-incrémenté : le lot est donc créé avec un code provisoire, puis mis
  // à jour juste après l'insertion — dans la même transaction, aucun autre
  // appelant ne voit la valeur intermédiaire. Les lignes Media sont écrites
  // après les uploads : si l'un d'eux échoue, la transaction s'annule et le
  // lot n'existe pas.
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
        // Le lot vient d'être déclaré : aucun mouvement n'a encore eu lieu,
        // la quantité disponible est donc exactement celle déclarée.
        quantityAvailable: asQuantity(quantity),
        status: 'PENDING_VALIDATION',
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
          // La première photo envoyée est la photo principale : c'est elle
          // qui sert de vignette dans les listes.
          isPrimary: i === 0,
          position: i,
        },
      });
    }

    return misAJour;
  });

  const complet = await prisma.stockLot.findUnique({
    where: { id: lot.id },
    include: LOT_INCLUDE,
  });

  res.status(201).json(lotToSupplierDto(complet));
};

// GET /api/v2/supplier/lots?status=&page=&limit=
export const listLots = async (req, res) => {
  const profile = await profilFournisseur(req.user.id);
  const { status } = req.query;
  if (status && !LOT_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = { supplierId: profile.id, ...(status ? { status } : {}) };

  const [items, total] = await Promise.all([
    prisma.stockLot.findMany({
      where,
      include: LOT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockLot.count({ where }),
  ]);

  res.json({ items: items.map(lotToSupplierDto), page, limit, total });
};

// GET /api/v2/supplier/lots/:id
export const getLot = async (req, res) => {
  const profile = await profilFournisseur(req.user.id);

  const lot = await prisma.stockLot.findFirst({
    where: { id: req.params.id, supplierId: profile.id },
    include: LOT_INCLUDE,
  });

  // 404 et non 403 : dire qu'un lot existe sans en être le propriétaire
  // révélerait à un fournisseur qu'un concurrent a déclaré un lot.
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }

  res.json(lotToSupplierDto(lot));
};

// PATCH /api/v2/supplier/lots/:id
export const updateLot = async (req, res) => {
  const profile = await profilFournisseur(req.user.id);

  const lot = await prisma.stockLot.findFirst({
    where: { id: req.params.id, supplierId: profile.id },
  });
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }
  if (!STATUTS_MODIFIABLES.includes(lot.status)) {
    throw Object.assign(new Error('Seul un lot en attente de validation peut être modifié'), {
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  }

  const { agreedUnitPrice, quantity, expiresAt, harvestedAt, packagingNote, qualityNote } = req.body;

  const data = {};
  if (agreedUnitPrice !== undefined) data.agreedUnitPrice = asMoney(agreedUnitPrice);
  if (quantity !== undefined) {
    const nouvelle = asQuantity(quantity);
    // L'invariant du lot (initial = disponible + réservé + vendu + perdu)
    // interdit de descendre sous ce qui a déjà été réservé, vendu ou perdu.
    const engage = lot.quantityReserved.plus(lot.quantitySold).plus(lot.quantityLost);
    if (nouvelle.lessThan(engage)) {
      return res.status(400).json({ error: 'Quantité inférieure aux quantités réservées, vendues ou perdues' });
    }
    // Quantité déclarée et disponible réécrites ensemble : en
    // PENDING_VALIDATION aucun mouvement n'a encore eu lieu, donc la
    // disponible redevient exactement la nouvelle quantité déclarée.
    data.quantityInitial = nouvelle;
    data.quantityAvailable = nouvelle;
  }
  if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (harvestedAt !== undefined) data.harvestedAt = harvestedAt ? new Date(harvestedAt) : null;
  if (packagingNote !== undefined) data.packagingNote = packagingNote ?? null;
  if (qualityNote !== undefined) data.qualityNote = qualityNote ?? null;

  const misAJour = await prisma.stockLot.update({
    where: { id: lot.id },
    data,
    include: LOT_INCLUDE,
  });

  res.json(lotToSupplierDto(misAJour));
};

// DELETE /api/v2/supplier/lots/:id
//
// Autorisé tant que le lot n'a pas été validé : après, le stock est tracé par
// les mouvements (P2.3) et il faut passer par le retrait (P2.4). La
// suppression du lot emporte ses photos Media (ON DELETE CASCADE) : c'est une
// suppression définitive, sans aucun mouvement de stock.
export const deleteLot = async (req, res) => {
  const profile = await profilFournisseur(req.user.id);

  const lot = await prisma.stockLot.findFirst({
    where: { id: req.params.id, supplierId: profile.id },
  });
  if (!lot) {
    return res.status(404).json({ error: 'Lot introuvable' });
  }
  if (!STATUTS_SUPPRIMABLES.includes(lot.status)) {
    throw Object.assign(
      new Error('Seul un lot en attente de validation ou rejeté peut être supprimé'),
      { statusCode: 409, code: 'INVALID_STATE_TRANSITION' }
    );
  }

  await prisma.stockLot.delete({ where: { id: lot.id } });
  res.status(204).send();
};
