import prisma from '../config/prisma.js';

function pagination(query) {
  const page = query.page;
  const limit = query.limit;
  return { page, limit, skip: (page - 1) * limit };
}

async function list(model, query, where, select, orderBy) {
  const { page, limit, skip } = pagination(query);
  const [items, total] = await Promise.all([
    model.findMany({ where, select, orderBy, skip, take: limit }),
    model.count({ where }),
  ]);
  return { items, page, limit, total };
}

export const listCategories = async (req, res) => {
  const result = await list(
    prisma.productCategory,
    req.query,
    { isActive: true },
    { id: true, code: true, label: true },
    { label: 'asc' },
  );
  res.json(result);
};

export const listUnits = async (req, res) => {
  const result = await list(
    prisma.unit,
    req.query,
    {},
    { id: true, code: true, label: true },
    { label: 'asc' },
  );
  res.json(result);
};

export const listProducts = async (req, res) => {
  const where = {
    isActive: true,
    category: { isActive: true },
    ...(req.query.categoryId !== undefined && { categoryId: req.query.categoryId }),
    ...(req.query.q && { name: { contains: req.query.q } }),
  };
  const result = await list(
    prisma.product,
    req.query,
    where,
    {
      id: true,
      name: true,
      description: true,
      isPerishable: true,
      imageUrl: true,
      category: { select: { id: true, code: true, label: true } },
      unit: { select: { id: true, code: true, label: true } },
    },
    { name: 'asc' },
  );
  res.json(result);
};

export const listZones = async (req, res) => {
  const result = await list(
    prisma.zone,
    req.query,
    { isActive: true },
    { id: true, name: true, city: true, region: true },
    { name: 'asc' },
  );
  res.json(result);
};

export const listHubs = async (req, res) => {
  const where = {
    isActive: true,
    zone: { isActive: true },
    ...(req.query.zoneId !== undefined && { zoneId: req.query.zoneId }),
    ...(req.query.acceptsDropoff !== undefined && { acceptsDropoff: req.query.acceptsDropoff }),
    ...(req.query.acceptsPickup !== undefined && { acceptsPickup: req.query.acceptsPickup }),
  };
  const result = await list(
    prisma.hub,
    req.query,
    where,
    {
      id: true,
      name: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      zoneId: true,
      acceptsDropoff: true,
      acceptsPickup: true,
    },
    { name: 'asc' },
  );
  res.json(result);
};
