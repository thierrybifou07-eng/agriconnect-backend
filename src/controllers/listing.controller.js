import prisma from '../config/prisma.js';
import { uploadBufferToCloudinary } from '../utils/cloudinaryUpload.js';
import { getLookupId } from '../utils/lookupCache.js';

const farmerSelect = { id: true, firstname: true, lastname: true, phone: true, location: true };

const listingInclude = {
  farmer: { select: farmerSelect },
  category: true,
  status: true,
  media: true,
};

// GET /api/listings?category=&location=&minPrice=&maxPrice=&search=&farmerId=&status=
// Note MySQL : pas de "mode: insensitive" (non supporté par ce connecteur Prisma) -
// la casse dépend de la collation de la base (utf8mb4_general_ci est insensible par défaut).
export const getListings = async (req, res) => {
  const { category, location, minPrice, maxPrice, search, farmerId, status } = req.query;

  const where = {
    ...(category && { category: { code: category } }),
    ...(location && { location: { contains: location } }),
    ...(farmerId && { farmerId }),
    status: { code: status || 'ACTIVE' },
    ...((minPrice || maxPrice) && {
      price: {
        ...(minPrice && { gte: parseFloat(minPrice) }),
        ...(maxPrice && { lte: parseFloat(maxPrice) }),
      },
    }),
    ...(search && { title: { contains: search } }),
  };

  const listings = await prisma.listing.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: listingInclude,
  });

  res.json(listings);
};

// GET /api/listings/:id
export const getListingById = async (req, res) => {
  const listing = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: listingInclude,
  });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  res.json(listing);
};

// POST /api/listings  (category validé contre ListingCategory par Joi en amont)
export const createListing = async (req, res) => {
  const { title, category, price, quantity, unit, location, description, latitude, longitude } = req.body;

  const [categoryId, statusId] = await Promise.all([
    getLookupId('listingCategory', category),
    getLookupId('listingStatus', 'ACTIVE'),
  ]);

  const listing = await prisma.listing.create({
    data: {
      title,
      categoryId,
      statusId,
      price,
      quantity,
      unit,
      location,
      description,
      farmerId: req.user.id,
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
    },
    include: listingInclude,
  });

  res.status(201).json(listing);
};

// PATCH /api/listings/:id
export const updateListing = async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (listing.farmerId !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas propriétaire de cette annonce" });
  }

  const { title, category, price, quantity, unit, location, description, status, latitude, longitude } = req.body;

  const [categoryId, statusId] = await Promise.all([
    category ? getLookupId('listingCategory', category) : Promise.resolve(null),
    status ? getLookupId('listingStatus', status) : Promise.resolve(null),
  ]);

  const updated = await prisma.listing.update({
    where: { id: req.params.id },
    data: {
      ...(title && { title }),
      ...(categoryId && { categoryId }),
      ...(price !== undefined && { price }),
      ...(quantity !== undefined && { quantity }),
      ...(unit && { unit }),
      ...(location && { location }),
      ...(description !== undefined && { description }),
      ...(statusId && { statusId }),
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
    },
    include: listingInclude,
  });

  res.json(updated);
};

// DELETE /api/listings/:id
export const deleteListing = async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (listing.farmerId !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas propriétaire de cette annonce" });
  }

  // Une annonce ayant deja ete commandee ne peut pas disparaitre : les
  // commandes sont de l'historique commercial et l'agriculteur doit pouvoir
  // les consulter. Supprimer l'annonce en cascade detruirait aussi les
  // conversations et les photos qui s'y rattachent.
  //
  // Auparavant, la suppression partait directement sur delete() et levait une
  // violation de cle etrangere, donc un 500 : impossible de retirer une
  // annonce vendue, ce qui est une operation courante.
  const ordersCount = await prisma.order.count({ where: { listingId: listing.id } });
  if (ordersCount > 0) {
    return res.status(409).json({
      error:
        'Cette annonce a déjà fait l’objet de commandes et ne peut pas être supprimée. ' +
        'Désactivez-la pour la retirer du catalogue tout en conservant son historique.',
      ordersCount,
    });
  }

  // Conversations, messages et medias n'ont de valeur que rattaches a
  // l'annonce : ils partent avec elle, dans une seule transaction pour ne pas
  // laisser l'annonce a moitie supprimee.
  await prisma.$transaction(async (tx) => {
    await tx.message.deleteMany({
      where: { conversation: { listingId: listing.id } },
    });
    await tx.conversation.deleteMany({ where: { listingId: listing.id } });
    await tx.media.deleteMany({ where: { ownerListingId: listing.id } });
    await tx.listing.delete({ where: { id: listing.id } });
  });

  res.status(204).send();
};

// POST /api/listings/:id/photos  -> crée des lignes Media
export const uploadPhotos = async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (listing.farmerId !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas propriétaire de cette annonce" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Aucune photo fournie (champ "photos")' });
  }

  const mediaTypeId = await getLookupId('mediaType', 'IMAGE');

  const created = await Promise.all(
    req.files.map(async (file) => {
      const [url, mimeTypeId] = await Promise.all([
        uploadBufferToCloudinary(file.buffer),
        getLookupId('mimeType', file.mimetype),
      ]);

      return prisma.media.create({
        data: { ownerListingId: listing.id, mediaTypeId, mimeTypeId, url, fileSize: file.size },
      });
    })
  );

  res.status(201).json(created);
};
