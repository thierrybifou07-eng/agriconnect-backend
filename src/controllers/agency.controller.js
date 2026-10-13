import prisma from '../config/prisma.js';
import { recordAudit } from '../utils/audit.js';
import { asMoney } from '../utils/money.js';

// Agences de transport : l'administrateur pilote le parc d'agences, leur
// couverture géographique et leurs tarifs par zone (plan v2, P5.1).
//
// Pas de suppression d'agence : une agence se désactive (isActive=false via
// PATCH), ce qui préserve les livraisons et les profils livreurs rattachés.
// En revanche, la couverture d'une zone (AgencyZone) se supprime : c'est une
// configuration, pas un historique.

const ENTIER = /^[0-9]+$/;

// :id passe par coerceIdParam (router.param), mais :zoneId n'a pas de
// crochet de conversion : on applique ici la même règle qu'au middleware —
// un identifiant non numérique est un 400, pas une erreur serveur.
function parseZoneId(raw) {
  if (!ENTIER.test(raw)) {
    return null;
  }
  return Number(raw);
}

// Pagination commune aux listes : mêmes bornes que
// GET /api/v2/admin/categories (page >= 1, 1 <= limit <= 100).
function parsePagination(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// Filtre commun ?active=true|false, comme pour les référentiels du catalogue.
function parseActiveFilter(query) {
  const { active } = query;
  if (active === undefined) return {};
  if (active !== 'true' && active !== 'false') {
    throw Object.assign(new Error("Le paramètre active doit valoir 'true' ou 'false'"), { statusCode: 400 });
  }
  return { isActive: active === 'true' };
}

// ---------------------------------------------------------------------
// AGENCES
// ---------------------------------------------------------------------

// GET /api/v2/admin/agencies?active=&page=&limit=
export const listAgencies = async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const where = parseActiveFilter(req.query);

  const [items, total] = await Promise.all([
    prisma.transportAgency.findMany({ where, orderBy: { id: 'asc' }, skip, take: limit }),
    prisma.transportAgency.count({ where }),
  ]);

  res.json({ items, page, limit, total });
};

// POST /api/v2/admin/agencies
export const createAgency = async (req, res) => {
  const {
    name,
    contactName,
    phone,
    email,
    insuranceProvider,
    insurancePolicyNumber,
    insuranceExpiresAt,
    isActive,
  } = req.body;

  // L'unicité du nom est vérifiée ici pour renvoyer un 409 lisible ; la
  // contrainte en base reste le garde-fou des écritures concurrentes.
  const existing = await prisma.transportAgency.findUnique({ where: { name } });
  if (existing) {
    return res.status(409).json({ error: 'Une agence existe déjà avec ce nom' });
  }

  const agency = await prisma.$transaction(async (tx) => {
    const created = await tx.transportAgency.create({
      data: {
        name,
        contactName: contactName ?? null,
        phone,
        email: email ?? null,
        insuranceProvider: insuranceProvider ?? null,
        insurancePolicyNumber: insurancePolicyNumber ?? null,
        insuranceExpiresAt: insuranceExpiresAt ?? null,
        isActive: isActive ?? true,
      },
    });

    // Audit dans la même transaction : l'historique survit à l'action,
    // pas l'inverse.
    await recordAudit(tx, {
      actorUser: req.user,
      action: 'AGENCY_CREATED',
      entityType: 'TransportAgency',
      entityId: created.id,
      metadata: { name, phone, isActive: created.isActive },
    });

    return created;
  });

  res.status(201).json(agency);
};

// PATCH /api/v2/admin/agencies/:id
export const updateAgency = async (req, res) => {
  const { name, contactName, phone, email, insuranceProvider, insurancePolicyNumber, insuranceExpiresAt, isActive } =
    req.body;

  const agency = await prisma.transportAgency.findUnique({ where: { id: req.params.id } });
  if (!agency) return res.status(404).json({ error: 'Agence introuvable' });

  if (name !== undefined && name !== agency.name) {
    const existing = await prisma.transportAgency.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: 'Une agence existe déjà avec ce nom' });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data = {};
    if (name !== undefined) data.name = name;
    if (contactName !== undefined) data.contactName = contactName ?? null;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email ?? null;
    if (insuranceProvider !== undefined) data.insuranceProvider = insuranceProvider ?? null;
    if (insurancePolicyNumber !== undefined) data.insurancePolicyNumber = insurancePolicyNumber ?? null;
    if (insuranceExpiresAt !== undefined) data.insuranceExpiresAt = insuranceExpiresAt ?? null;
    if (isActive !== undefined) data.isActive = isActive;

    const result = await tx.transportAgency.update({ where: { id: agency.id }, data });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'AGENCY_UPDATED',
      entityType: 'TransportAgency',
      entityId: agency.id,
      metadata: { changes: data },
    });

    return result;
  });

  res.json(updated);
};

// ---------------------------------------------------------------------
// COUVERTURE DES ZONES (TARIFS)
// ---------------------------------------------------------------------

// PUT /api/v2/admin/agencies/:id/zones/:zoneId
// Crée ou met à jour la couverture d'une zone par l'agence (upsert) : la
// configuration est entièrement remplacée par le corps de la requête.
export const upsertAgencyZone = async (req, res) => {
  const agency = await prisma.transportAgency.findUnique({ where: { id: req.params.id } });
  if (!agency) return res.status(404).json({ error: 'Agence introuvable' });

  const zoneId = parseZoneId(req.params.zoneId);
  if (zoneId === null) return res.status(400).json({ error: 'Identifiant invalide' });

  // Une couverture pointe vers une zone existante : sans cette vérification,
  // la contrainte de clé étrangère remonterait une erreur 500 illisible.
  const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
  if (!zone) return res.status(400).json({ error: 'Zone introuvable' });

  const { baseFee, perKmFee, isActive } = req.body;

  // La couverture existante est lue avant la transaction : elle décide du
  // code de réponse (201 création, 200 mise à jour) et de l'action d'audit.
  const existing = await prisma.agencyZone.findUnique({
    where: { agencyId_zoneId: { agencyId: agency.id, zoneId } },
  });

  // Les tarifs arrivent en nombre par la validation Joi : on les arrondit
  // au centime et on les passe en Decimal avant écriture, sans jamais
  // calculer d'argent en Number.
  const data = {
    baseFee: asMoney(baseFee),
    perKmFee: asMoney(perKmFee),
    isActive: isActive ?? true,
  };

  const saved = await prisma.$transaction(async (tx) => {
    const result = existing
      ? await tx.agencyZone.update({ where: { agencyId_zoneId: { agencyId: agency.id, zoneId } }, data })
      : await tx.agencyZone.create({ data: { agencyId: agency.id, zoneId, ...data } });

    // Audit dans la même transaction, avec la distinction création /
    // mise à jour : l'historique doit dire quelle opération a eu lieu.
    await recordAudit(tx, {
      actorUser: req.user,
      action: existing ? 'AGENCY_ZONE_UPDATED' : 'AGENCY_ZONE_CREATED',
      entityType: 'AgencyZone',
      entityId: result.zoneId,
      metadata: { agencyId: agency.id, zoneId, ...data },
    });

    return result;
  });

  res.status(existing ? 200 : 201).json(saved);
};

// DELETE /api/v2/admin/agencies/:id/zones/:zoneId
// Retire la couverture de la zone par l'agence : suppression de la ligne
// AgencyZone, sans toucher à l'agence ni aux livraisons passées.
export const removeAgencyZone = async (req, res) => {
  const agency = await prisma.transportAgency.findUnique({ where: { id: req.params.id } });
  if (!agency) return res.status(404).json({ error: 'Agence introuvable' });

  const zoneId = parseZoneId(req.params.zoneId);
  if (zoneId === null) return res.status(400).json({ error: 'Identifiant invalide' });

  const existing = await prisma.agencyZone.findUnique({
    where: { agencyId_zoneId: { agencyId: agency.id, zoneId } },
  });
  if (!existing) return res.status(404).json({ error: 'Couverture de zone introuvable' });

  await prisma.$transaction(async (tx) => {
    await tx.agencyZone.delete({ where: { agencyId_zoneId: { agencyId: agency.id, zoneId } } });

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'AGENCY_ZONE_REMOVED',
      entityType: 'AgencyZone',
      entityId: zoneId,
      metadata: { agencyId: agency.id, zoneId },
    });
  });

  // Réponse brute : la clé primaire de AgencyZone est le couple
  // (agencyId, zoneId), il n'y a pas de colonne id.
  res.json({ agencyId: agency.id, zoneId });
};

// ---------------------------------------------------------------------
// LIVREURS
// ---------------------------------------------------------------------

// GET /api/v2/admin/agencies/:id/drivers
// Liste les livreurs rattachés à l'agence, avec les coordonnées du compte
// utilisateur (indispensables pour contacter un livreur).
export const listAgencyDrivers = async (req, res) => {
  const agency = await prisma.transportAgency.findUnique({ where: { id: req.params.id } });
  if (!agency) return res.status(404).json({ error: 'Agence introuvable' });

  const drivers = await prisma.driverProfile.findMany({
    where: { agencyId: agency.id },
    orderBy: { id: 'asc' },
    include: {
      user: {
        select: {
          id: true,
          firstname: true,
          lastname: true,
          phone: true,
          email: true,
          userStatus: { select: { code: true } },
        },
      },
    },
  });

  res.json({ items: drivers, total: drivers.length });
};
