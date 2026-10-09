import prisma from '../config/prisma.js';
import { recordAudit } from '../utils/audit.js';

// Référentiels du catalogue : catégories, unités, produits, zones et points
// de dépôt. Pas de suppression — une ligne se désactive (isActive=false via
// PATCH), ce qui préserve les lots, commandes et profils qui y font référence.

// Pagination commune aux listes : mêmes bornes que
// GET /api/v2/admin/verifications (page >= 1, 1 <= limit <= 100).
function parsePagination(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// Filtre commun ?active=true|false. Une valeur hors énumération est un 400,
// pas une erreur serveur : laisser passer "active=foo" ferait échouer Prisma
// plus loin avec une erreur de validation peu lisible.
function parseActiveFilter(query) {
  const { active } = query;
  if (active === undefined) return {};
  if (active !== 'true' && active !== 'false') {
    throw Object.assign(new Error("Le paramètre active doit valoir 'true' ou 'false'"), { statusCode: 400 });
  }
  return { isActive: active === 'true' };
}

// Lecture paginée commune : items et total en parallèle, comme
// GET /api/v2/admin/verifications.
async function paginatedFind(model, req, where) {
  const { page, limit, skip } = parsePagination(req);
  const [items, total] = await Promise.all([
    model.findMany({ where, orderBy: { id: 'asc' }, skip, take: limit }),
    model.count({ where }),
  ]);
  return { items, page, limit, total };
}

// ---------------------------------------------------------------------
// CATÉGORIES
// ---------------------------------------------------------------------

// GET /api/v2/admin/categories?active=&page=&limit=
export const listCategories = async (req, res) => {
  const result = await paginatedFind(prisma.productCategory, req, parseActiveFilter(req.query));
  res.json(result);
};

// POST /api/v2/admin/categories
export const createCategory = async (req, res) => {
  const { code, label, isActive } = req.body;

  // L'unicité du code est vérifiée ici pour renvoyer un 409 lisible ; la
  // contrainte en base reste le garde-fou des écritures concurrentes.
  const existing = await prisma.productCategory.findUnique({ where: { code } });
  if (existing) {
    return res.status(409).json({ error: 'Une catégorie existe déjà avec ce code' });
  }

  const category = await prisma.$transaction(async (tx) => {
    const created = await tx.productCategory.create({
      data: { code, label, isActive: isActive ?? true },
    });

    // Audit dans la même transaction : l'historique survit à l'action,
    // pas l'inverse.
    await recordAudit(tx, {
      actorUser: req.user,
      action: 'CATEGORY_CREATED',
      entityType: 'ProductCategory',
      entityId: created.id,
      metadata: { code, label, isActive: created.isActive },
    });

    return created;
  });

  res.status(201).json(category);
};

// PATCH /api/v2/admin/categories/:id
export const updateCategory = async (req, res) => {
  const { code, label, isActive } = req.body;

  const category = await prisma.productCategory.findUnique({ where: { id: req.params.id } });
  if (!category) return res.status(404).json({ error: 'Catégorie introuvable' });

  if (code !== undefined && code !== category.code) {
    const existing = await prisma.productCategory.findUnique({ where: { code } });
    if (existing) {
      return res.status(409).json({ error: 'Une catégorie existe déjà avec ce code' });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (code !== undefined) data.code = code;
    if (label !== undefined) data.label = label;
    if (isActive !== undefined) data.isActive = isActive;

    const result = await tx.productCategory.update({ where: { id: category.id }, data });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'CATEGORY_UPDATED',
      entityType: 'ProductCategory',
      entityId: category.id,
      metadata: { changes: data },
    });

    return result;
  });

  res.json(updated);
};

// ---------------------------------------------------------------------
// UNITÉS
// ---------------------------------------------------------------------

// GET /api/v2/admin/units?page=&limit=
// Pas de filtre ?active= : Unit n'a pas de colonne isActive (schéma cible).
export const listUnits = async (req, res) => {
  const result = await paginatedFind(prisma.unit, req, {});
  res.json(result);
};

// POST /api/v2/admin/units
export const createUnit = async (req, res) => {
  const { code, label } = req.body;

  const existing = await prisma.unit.findUnique({ where: { code } });
  if (existing) {
    return res.status(409).json({ error: 'Une unité existe déjà avec ce code' });
  }

  const unit = await prisma.$transaction(async (tx) => {
    const created = await tx.unit.create({ data: { code, label } });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'UNIT_CREATED',
      entityType: 'Unit',
      entityId: created.id,
      metadata: { code, label },
    });

    return created;
  });

  res.status(201).json(unit);
};

// PATCH /api/v2/admin/units/:id — code et label uniquement (voir plus haut).
export const updateUnit = async (req, res) => {
  const { code, label } = req.body;

  const unit = await prisma.unit.findUnique({ where: { id: req.params.id } });
  if (!unit) return res.status(404).json({ error: 'Unité introuvable' });

  if (code !== undefined && code !== unit.code) {
    const existing = await prisma.unit.findUnique({ where: { code } });
    if (existing) {
      return res.status(409).json({ error: 'Une unité existe déjà avec ce code' });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (code !== undefined) data.code = code;
    if (label !== undefined) data.label = label;

    const result = await tx.unit.update({ where: { id: unit.id }, data });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'UNIT_UPDATED',
      entityType: 'Unit',
      entityId: unit.id,
      metadata: { changes: data },
    });

    return result;
  });

  res.json(updated);
};

// ---------------------------------------------------------------------
// PRODUITS
// ---------------------------------------------------------------------

// GET /api/v2/admin/products?active=&page=&limit=
export const listProducts = async (req, res) => {
  const result = await paginatedFind(prisma.product, req, parseActiveFilter(req.query));
  res.json(result);
};

// POST /api/v2/admin/products
// categoryId et unitId validés par le validator (external) : catégorie
// existante et active, unité existante.
export const createProduct = async (req, res) => {
  const { categoryId, unitId, name, description, imageUrl, isPerishable, isActive } = req.body;

  // Le couple (categoryId, name) est unique en base : vérifié ici pour
  // renvoyer un 409 lisible plutôt que l'erreur serveur de la contrainte.
  const existing = await prisma.product.findUnique({
    where: { categoryId_name: { categoryId, name } },
  });
  if (existing) {
    return res.status(409).json({ error: 'Un produit existe déjà avec ce nom dans cette catégorie' });
  }

  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        categoryId,
        unitId,
        name,
        description: description ?? undefined,
        imageUrl: imageUrl ?? undefined,
        isPerishable: isPerishable ?? true,
        isActive: isActive ?? true,
      },
    });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'PRODUCT_CREATED',
      entityType: 'Product',
      entityId: created.id,
      metadata: { categoryId, unitId, name, isPerishable: created.isPerishable },
    });

    return created;
  });

  res.status(201).json(product);
};

// PATCH /api/v2/admin/products/:id
export const updateProduct = async (req, res) => {
  const { categoryId, unitId, name, description, imageUrl, isPerishable, isActive } = req.body;

  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });

  // Changement de catégorie ou de nom : le couple (categoryId, name) doit
  // rester unique. La contrainte en base ne protège que les écritures
  // concurrentes ; ici on renvoie un 409 lisible.
  if (categoryId !== undefined || name !== undefined) {
    const clash = await prisma.product.findUnique({
      where: { categoryId_name: { categoryId: categoryId ?? product.categoryId, name: name ?? product.name } },
    });
    if (clash && clash.id !== product.id) {
      return res.status(409).json({ error: 'Un produit existe déjà avec ce nom dans cette catégorie' });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (categoryId !== undefined) data.categoryId = categoryId;
    if (unitId !== undefined) data.unitId = unitId;
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description ?? null;
    if (imageUrl !== undefined) data.imageUrl = imageUrl ?? null;
    if (isPerishable !== undefined) data.isPerishable = isPerishable;
    if (isActive !== undefined) data.isActive = isActive;

    const result = await tx.product.update({ where: { id: product.id }, data });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'PRODUCT_UPDATED',
      entityType: 'Product',
      entityId: product.id,
      metadata: { changes: data },
    });

    return result;
  });

  res.json(updated);
};

// ---------------------------------------------------------------------
// ZONES
// ---------------------------------------------------------------------

// GET /api/v2/admin/zones?active=&page=&limit=
export const listZones = async (req, res) => {
  const result = await paginatedFind(prisma.zone, req, parseActiveFilter(req.query));
  res.json(result);
};

// POST /api/v2/admin/zones
export const createZone = async (req, res) => {
  const { name, city, region, isActive } = req.body;

  const existing = await prisma.zone.findUnique({ where: { name } });
  if (existing) {
    return res.status(409).json({ error: 'Une zone existe déjà avec ce nom' });
  }

  const zone = await prisma.$transaction(async (tx) => {
    const created = await tx.zone.create({
      data: { name, city: city ?? null, region: region ?? null, isActive: isActive ?? true },
    });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'ZONE_CREATED',
      entityType: 'Zone',
      entityId: created.id,
      metadata: { name, city: created.city, region: created.region },
    });

    return created;
  });

  res.status(201).json(zone);
};

// PATCH /api/v2/admin/zones/:id
export const updateZone = async (req, res) => {
  const { name, city, region, isActive } = req.body;

  const zone = await prisma.zone.findUnique({ where: { id: req.params.id } });
  if (!zone) return res.status(404).json({ error: 'Zone introuvable' });

  if (name !== undefined && name !== zone.name) {
    const existing = await prisma.zone.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: 'Une zone existe déjà avec ce nom' });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (name !== undefined) data.name = name;
    if (city !== undefined) data.city = city ?? null;
    if (region !== undefined) data.region = region ?? null;
    if (isActive !== undefined) data.isActive = isActive;

    const result = await tx.zone.update({ where: { id: zone.id }, data });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'ZONE_UPDATED',
      entityType: 'Zone',
      entityId: zone.id,
      metadata: { changes: data },
    });

    return result;
  });

  res.json(updated);
};

// ---------------------------------------------------------------------
// POINTS DE DÉPÔT (HUBS)
// ---------------------------------------------------------------------

// GET /api/v2/admin/hubs?active=&page=&limit=
export const listHubs = async (req, res) => {
  const result = await paginatedFind(prisma.hub, req, parseActiveFilter(req.query));
  res.json(result);
};

// POST /api/v2/admin/hubs
// zoneId validé par le validator (external) : la zone doit exister.
export const createHub = async (req, res) => {
  const { name, address, city, latitude, longitude, zoneId, acceptsDropoff, acceptsPickup, isActive } = req.body;

  const hub = await prisma.$transaction(async (tx) => {
    const created = await tx.hub.create({
      data: {
        name,
        address,
        city: city ?? null,
        latitude,
        longitude,
        zoneId,
        acceptsDropoff: acceptsDropoff ?? true,
        acceptsPickup: acceptsPickup ?? true,
        isActive: isActive ?? true,
      },
    });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'HUB_CREATED',
      entityType: 'Hub',
      entityId: created.id,
      metadata: { name, zoneId, latitude, longitude },
    });

    return created;
  });

  res.status(201).json(hub);
};

// PATCH /api/v2/admin/hubs/:id
export const updateHub = async (req, res) => {
  const { name, address, city, latitude, longitude, zoneId, acceptsDropoff, acceptsPickup, isActive } = req.body;

  const hub = await prisma.hub.findUnique({ where: { id: req.params.id } });
  if (!hub) return res.status(404).json({ error: 'Point de dépôt introuvable' });

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (name !== undefined) data.name = name;
    if (address !== undefined) data.address = address;
    if (city !== undefined) data.city = city ?? null;
    if (latitude !== undefined) data.latitude = latitude;
    if (longitude !== undefined) data.longitude = longitude;
    if (zoneId !== undefined) data.zoneId = zoneId;
    if (acceptsDropoff !== undefined) data.acceptsDropoff = acceptsDropoff;
    if (acceptsPickup !== undefined) data.acceptsPickup = acceptsPickup;
    if (isActive !== undefined) data.isActive = isActive;

    const result = await tx.hub.update({ where: { id: hub.id }, data });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'HUB_UPDATED',
      entityType: 'Hub',
      entityId: hub.id,
      metadata: { changes: data },
    });

    return result;
  });

  res.json(updated);
};
