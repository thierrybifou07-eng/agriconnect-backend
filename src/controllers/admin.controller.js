import bcrypt from 'bcrypt';
import prisma from '../config/prisma.js';
import { getLookupId } from '../utils/lookupCache.js';
import { closeAllSessions } from '../utils/session.js';
import { emitSessionRevoked } from '../sockets/revocation.js';
// Meme pile que l inscription (src/config/email) : un seul moteur de rendu,
// une seule configuration SMTP.
import { sendTemplateEmail } from '../config/email/sendMail.js';
// v2 du SDK : utils.private_download_url genere l URL signée de courte duree
// qui donne acces a un asset private (type 'authenticated').
import { v2 as cloudinary } from 'cloudinary';
import { recordAudit } from '../utils/audit.js';

const userSafeSelect = {
  id: true,
  firstname: true,
  lastname: true,
  phone: true,
  email: true,
  role: { select: { code: true, label: true, level: true } },
  userStatus: { select: { code: true, label: true } },
  location: true,
  profileVerificationStatus: true,
  createdAt: true,
};

// GET /api/admin/users?role=&search=&status=&profileVerificationStatus=
// Note MySQL : pas de "mode: insensitive" (non supporté par ce connecteur Prisma).
export const listUsers = async (req, res) => {
  const { role, search, status, profileVerificationStatus } = req.query;

  const users = await prisma.user.findMany({
    where: {
      ...(role && { role: { code: role } }),
      ...(status && { userStatus: { code: status } }),
      // La verification du PROFIL (documents) est distincte de emailVerified :
      // un filtre separe permet de lister les comptes a examiner sans melanger
      // les deux notions.
      ...(profileVerificationStatus && { profileVerificationStatus }),
      ...(search && {
        // Le nom est stocke en deux colonnes : la recherche doit porter sur les
        // deux, sinon un administrateur qui cherche "Benali" ne trouve rien.
        OR: [
          { firstname: { contains: search } },
          { lastname: { contains: search } },
          { phone: { contains: search } },
        ],
      }),
    },
    select: userSafeSelect,
    orderBy: { createdAt: 'desc' },
  });

  res.json(users);
};

// PATCH /api/admin/users/:id/suspend
export const suspendUser = async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { role: true } });
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

  if (target.role.code === 'ROOT') {
    return res.status(403).json({ error: 'Le compte ROOT ne peut pas être suspendu' });
  }
  if (target.role.level >= 50 && req.user.role.code !== 'ROOT') {
    return res.status(403).json({ error: 'Seul ROOT peut suspendre un compte administrateur' });
  }

  const suspendedStatusId = await getLookupId('userStatus', 'SUSPENDED');

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { userStatusId: suspendedStatusId },
    select: userSafeSelect,
  });

  // Suspendre un compte doit couper ses acces, pas seulement son autorisation de
  // requete. Sans cela, un utilisateur suspendu garde des sessions actives et
  // des websockets ouverts : il pourrait encore lire son profil et ecrire dans
  // une conversation. La session ouverte reste un acces reel.
  //
  // Le compte est mis a jour en base avant l'evenement : le client qui le recoit
  // et tente ensuite un appel se verra refuser par protect, ce qui evite la
  // situation inverse ou l'evenement part avant que la base ne soit a jour.
  await closeAllSessions(target.id);
  emitSessionRevoked(req.app?.get('io'), target.id, 'account_suspended');

  res.json(updated);
};

// PATCH /api/admin/users/:id/reactivate
export const reactivateUser = async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { role: true } });
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

  if (target.role.level >= 50 && req.user.role.code !== 'ROOT') {
    return res.status(403).json({ error: 'Seul ROOT peut réactiver un compte administrateur' });
  }

  const activeStatusId = await getLookupId('userStatus', 'ACTIVE');

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { userStatusId: activeStatusId },
    select: userSafeSelect,
  });

  res.json(updated);
};

// POST /api/admin/users  (ADMIN et ROOT)
// ADMIN est le compte le plus eleve que l API puisse creer : seul ROOT peut le
// delivrer. AGENT et DRIVER peuvent l etre par un ADMIN, avec leur profil dedie.
export const createStaffUser = async (req, res) => {
  const { firstname, lastname, phone, email, password, role, agent, driver } = req.body;

  if (role === 'ADMIN' && req.user.role.code !== 'ROOT') {
    return res.status(403).json({ error: 'Seul ROOT peut créer un compte administrateur' });
  }

  // L unicite de l email est verifiee comme celle du numero : la v1 ne
  // controlait que le telephone, et une collision d email faisait echouer la
  // creation en 500 au lieu de renvoyer un 409 lisible.
  const existingPhone = await prisma.user.findUnique({ where: { phone } });
  if (existingPhone) {
    return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro' });
  }
  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
  }

  const [roleId, userStatusId] = await Promise.all([
    getLookupId('role', role),
    getLookupId('userStatus', 'ACTIVE'),
  ]);

  const hashedPassword = await bcrypt.hash(password, 10);

  // Compte et profil dans une seule transaction : un echec sur le profil ne
  // doit pas laisser un compte orphelin, et inversement (meme principe que
  // l inscription, src/controllers/auth.controller.js).
  const staffUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { firstname, lastname, phone, email, password: hashedPassword, roleId, userStatusId },
      select: userSafeSelect,
    });

    if (role === 'AGENT') {
      const fiche = await tx.agent.create({
        data: { kind: 'HUMAN', userId: user.id, displayName: agent.displayName },
      });
      // Les codes ont valide en base dans le validator : ne reste que la
      // resolution code -> id pour les lignes de liaison.
      const capacites = await tx.agentCapability.findMany({
        where: { code: { in: agent.capabilities } },
        select: { id: true },
      });
      await tx.agentCapabilityLink.createMany({
        data: capacites.map((capacite) => ({ agentId: fiche.id, capabilityId: capacite.id })),
      });
    } else if (role === 'DRIVER') {
      await tx.driverProfile.create({
        data: {
          userId: user.id,
          agencyId: driver.agencyId,
          vehicleType: driver.vehicleType,
          plateNumber: driver.plateNumber,
        },
      });
    }

    return user;
  });

  // Non-bloquant : l'email part apres la reponse, et ne peut pas faire echouer
  // la creation du compte. Aucune donnee sensible n'y figure. roleLabel porte
  // le libelle du role cree (Administrateur, Agent AgriConnect, Livreur).
  if (staffUser.email) {
    sendTemplateEmail(
      staffUser.email,
      'Votre compte AgriConnect',
      'welcome',
      { username: `${staffUser.firstname} ${staffUser.lastname}`, roleLabel: staffUser.role.label }
    );
  }

  res.status(201).json(staffUser);
};

// GET /api/v2/admin/verifications?status=
//
// Liste paginée des documents de verification. Le filtre porte sur le statut
// du document (PENDING par defaut côté client), pas sur celui du compte.
export const listVerifications = async (req, res) => {
  const { status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = status ? { status } : {};

  const [items, total] = await Promise.all([
    prisma.verificationDocument.findMany({
      where,
      select: {
        id: true,
        type: true,
        status: true,
        note: true,
        createdAt: true,
        reviewedAt: true,
        user: {
          select: {
            id: true,
            firstname: true,
            lastname: true,
            email: true,
            role: { select: { code: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.verificationDocument.count({ where }),
  ]);

  res.json({ items, page, limit, total });
};

// GET /api/v2/admin/verifications/:id
//
// Detail d'un document + URL signée de courte duree (10 minutes). L'asset est
// prive (type 'authenticated') : seule une URL signée avec expiration permet de
// le servir, et elle devient inutilisable apres coup.
export const getVerification = async (req, res) => {
  const document = await prisma.verificationDocument.findUnique({
    where: { id: req.params.id },
    include: {
      user: {
        select: {
          id: true,
          firstname: true,
          lastname: true,
          email: true,
          role: { select: { code: true } },
        },
      },
      media: { include: { mimeType: { select: { code: true, extension: true } } } },
    },
  });
  if (!document) {
    return res.status(404).json({ error: 'Document introuvable' });
  }

  // Un document a un seul Media en pratique, mais la relation est 1-N : media
  // est un tableau, on prend la première ligne.
  const media = document.media[0] ?? null;
  let urlSignee = null;
  if (media?.publicId) {
    // Format depuis l extension seedee (.jpg, .png, .webp, .pdf) : c est le
    // format tel que Cloudinary l attend, sans le point.
    const format = media.mimeType?.extension?.replace(/^\./, '') ?? null;
    urlSignee = cloudinary.utils.private_download_url(media.publicId, format, {
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 10 * 60,
    });
  }

  res.json({
    id: document.id,
    type: document.type,
    status: document.status,
    note: document.note,
    createdAt: document.createdAt,
    reviewedAt: document.reviewedAt,
    user: document.user,
    media: media
      ? {
          id: media.id,
          isPrivate: media.isPrivate,
          mimeType: media.mimeType?.code ?? null,
          createdAt: media.createdAt,
          url: urlSignee,
        }
      : null,
  });
};

// PATCH /api/v2/admin/verifications/:id
//
// Decision d'examen. APPROVE -> document VERIFIED ; l'utilisateur devient
// VERIFIED quand il a au moins un document VERIFIED et aucun PENDING. REJECT ->
// document REJECTED ; sans document VERIFIED, l'utilisateur devient REJECTED.
// L'audit est ecrit dans la meme transaction que la decision.
export const reviewVerification = async (req, res) => {
  const { decision, note } = req.body; // validé par reviewVerificationSchema en amont

  const document = await prisma.verificationDocument.findUnique({ where: { id: req.params.id } });
  if (!document) {
    return res.status(404).json({ error: 'Document introuvable' });
  }
  if (document.status !== 'PENDING') {
    return res.status(409).json({ error: 'Ce document a déjà été examiné' });
  }

  const statutDocument = decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED';

  const { doc, profilMisAJour } = await prisma.$transaction(async (tx) => {
    const misAJour = await tx.verificationDocument.update({
      where: { id: document.id },
      data: {
        status: statutDocument,
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        note: note ?? null,
      },
    });

    // Relecture des documents du compte : la regle porte sur l'ensemble des
    // depots, pas sur le seul document examine ici.
    const documents = await tx.verificationDocument.findMany({
      where: { userId: document.userId },
      select: { status: true },
    });
    const aVerifie = documents.some((d) => d.status === 'VERIFIED');
    const aEnAttente = documents.some((d) => d.status === 'PENDING');

    let nouveauStatut = null;
    if (decision === 'APPROVE') {
      // APPROVE : VERIFIED seulement si aucun autre depot attend encore —
      // un compte verifié à moitié reste en attente.
      if (aVerifie && !aEnAttente) {
        nouveauStatut = 'VERIFIED';
      }
    } else if (!aVerifie) {
      // REJECT : rejete seulement si aucun document n'a ete valide.
      nouveauStatut = 'REJECTED';
    }

    if (nouveauStatut) {
      await tx.user.update({
        where: { id: document.userId },
        data:
          nouveauStatut === 'VERIFIED'
            ? { profileVerificationStatus: 'VERIFIED', profileVerifiedAt: new Date(), profileVerifiedById: req.user.id }
            : { profileVerificationStatus: 'REJECTED' },
      });
    }

    await recordAudit(tx, {
      actorUser: req.user,
      action: decision === 'APPROVE' ? 'PROFILE_DOCUMENT_APPROVED' : 'PROFILE_DOCUMENT_REJECTED',
      entityType: 'VerificationDocument',
      entityId: document.id,
      metadata: {
        decision,
        note: note ?? null,
        userId: document.userId,
        profileVerificationStatus: nouveauStatut,
      },
    });

    return { doc: misAJour, profilMisAJour: nouveauStatut };
  });

  res.json({
    id: document.id,
    type: document.type,
    status: doc.status,
    note: doc.note,
    reviewedAt: doc.reviewedAt,
    createdAt: doc.createdAt,
  });
};
