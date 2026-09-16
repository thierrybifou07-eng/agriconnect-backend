const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { uploadBufferToCloudinary } = require('../utils/cloudinaryUpload');

const farmerSelect = {
  id: true,
  fullName: true,
  phone: true,
  location: true,
  avatarUrl: true,
};

// GET /api/listings?category=&location=&minPrice=&maxPrice=&search=&farmerId=&status=
const getListings = asyncHandler(async (req, res) => {
  const { category, location, minPrice, maxPrice, search, farmerId, status } = req.query;

  const where = {
    ...(category && { category }),
    ...(location && { location: { contains: location, mode: 'insensitive' } }),
    ...(farmerId && { farmerId }),
    status: status || 'ACTIVE',
    ...((minPrice || maxPrice) && {
      price: {
        ...(minPrice && { gte: parseFloat(minPrice) }),
        ...(maxPrice && { lte: parseFloat(maxPrice) }),
      },
    }),
    ...(search && { title: { contains: search, mode: 'insensitive' } }),
  };

  const listings = await prisma.listing.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { farmer: { select: farmerSelect } },
  });

  res.json(listings);
});

// GET /api/listings/:id
const getListingById = asyncHandler(async (req, res) => {
  const listing = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: { farmer: { select: farmerSelect } },
  });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  res.json(listing);
});

// POST /api/listings  (la validation de format est faite par express-validator en amont)
const createListing = asyncHandler(async (req, res) => {
  const { title, category, price, quantity, unit, location, description, photos, latitude, longitude } = req.body;

  const listing = await prisma.listing.create({
    data: {
      title,
      category,
      price: parseFloat(price),
      quantity: parseFloat(quantity),
      unit,
      location,
      description,
      photos: photos || [],
      farmerId: req.user.id,
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
    },
  });

  res.status(201).json(listing);
});

// PATCH /api/listings/:id
const updateListing = asyncHandler(async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (listing.farmerId !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas propriétaire de cette annonce" });
  }

  const { title, category, price, quantity, unit, location, description, status, photos, latitude, longitude } =
    req.body;

  const updated = await prisma.listing.update({
    where: { id: req.params.id },
    data: {
      ...(title && { title }),
      ...(category && { category }),
      ...(price && { price: parseFloat(price) }),
      ...(quantity && { quantity: parseFloat(quantity) }),
      ...(unit && { unit }),
      ...(location && { location }),
      ...(description !== undefined && { description }),
      ...(status && { status }),
      ...(photos && { photos }),
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
    },
  });

  res.json(updated);
});

// DELETE /api/listings/:id
const deleteListing = asyncHandler(async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });

  if (!listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }
  if (listing.farmerId !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas propriétaire de cette annonce" });
  }

  await prisma.listing.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// POST /api/listings/:id/photos
const uploadPhotos = asyncHandler(async (req, res) => {
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

  const urls = await Promise.all(req.files.map((f) => uploadBufferToCloudinary(f.buffer)));

  const updated = await prisma.listing.update({
    where: { id: req.params.id },
    data: { photos: { push: urls } },
  });

  res.json(updated);
});

module.exports = { getListings, getListingById, createListing, updateListing, deleteListing, uploadPhotos };
