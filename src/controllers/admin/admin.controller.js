import bcrypt from 'bcrypt';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import prisma from '../../config/prisma.js';
import { getLookupId } from '../../utils/lookupCache.js';
import { closeAllSessions } from '../../utils/session.js';
import { emitSessionRevoked } from '../../sockets/revocation.js';
import { asMoney, toDecimal, toNumber } from '../../utils/money.js';
// Meme pile que l inscription (src/config/email) : un seul moteur de rendu,
// une seule configuration SMTP.
import { sendTemplateEmail } from '../../config/email/sendMail.js';
// jsonwebtoken est déjà dans les dépendances du projet (src/utils/jwt.js).
// On l'utilise pour générer un token signé de courte durée qui donne accès
// aux documents privés (remplace l'URL Cloudinary signée).
import jwt from 'jsonwebtoken';
import { recordAudit } from '../../utils/audit.js';
import {
  onProfileVerified,
  payReferral,
  rejectReferral,
} from '../../services/referral.service.js';
import { UPLOADS_ROOT } from '../../utils/localUpload.js';
import {UserStatusCode} from "../../utils/enums/enums.helpers.js";

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

  const suspendedStatusId = await getLookupId('userStatus', UserStatusCode.SUSPENDED);

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

// GET /api/v2/admin/settings — réglages de la plateforme (ligne unique id = 1).
// Aucun cache : la réponse porte toujours la valeur courante de la base, donc
// une modification par ROOT est effective à la requête suivante.
export const getSettings = async (req, res) => {
  const settings = await prisma.platformSetting.findUnique({ where: { id: 1 } });
  if (!settings) {
    return res.status(500).json({ error: 'Paramètres de la plateforme manquants' });
  }
  res.json(settings);
};

// PATCH /api/v2/admin/settings — modification partielle, ROOT seulement.
//
// Deux propriétés importantes :
//  - les taux ne sont jamais rétroactifs : chaque OrderItem porte les valeurs
//    figées au moment du devis, donc modifier un taux ne touche aucune commande
//    existante ;
//  - getSettings lit la base à chaque appel (aucun cache) : la modification est
//    effective à la requête suivante.
//
// La règle de cohérence (NONE -> buyerFeeValue = 0) s'applique APRÈS fusion
// avec la valeur actuelle : passer NONE alors que la valeur en base vaut 500
// est un 400, pas une écriture qui écraserait la valeur.
export const updateSettings = async (req, res) => {
  if (req.user.role.code !== 'ROOT') {
    return res.status(403).json({ error: 'Seul ROOT peut modifier les réglages de la plateforme' });
  }

  const body = req.body; // validé par updateSettingsSchema en amont

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.platformSetting.findUnique({ where: { id: 1 } });
    if (!current) {
      throw Object.assign(new Error('Paramètres de la plateforme manquants'), { statusCode: 500 });
    }

    // Fusion : seuls les champs fournis écrasent la valeur courante.
    const merged = { ...current };
    for (const key of Object.keys(body)) merged[key] = body[key];

    if (merged.buyerFeeType === 'NONE' && !toDecimal(merged.buyerFeeValue).isZero()) {
      throw Object.assign(
        new Error('Frais acheteur désactivés : buyerFeeValue doit valoir 0'),
        { statusCode: 400, code: 'INVALID_BUYER_FEE' }
      );
    }

    // Mise à jour partielle : argent et taux passent par Prisma.Decimal, jamais
    // par un Number ni une chaîne. Les récompenses (Decimal(14,2)) sont arrondies
    // au centime comme tout montant ; les taux gardent leurs 4 décimales.
    const data = {};
    if (body.supplierCommissionRate !== undefined) data.supplierCommissionRate = toDecimal(body.supplierCommissionRate);
    if (body.buyerFeeType !== undefined) data.buyerFeeType = body.buyerFeeType;
    if (body.buyerFeeValue !== undefined) data.buyerFeeValue = toDecimal(body.buyerFeeValue);
    if (body.transportMarkupRate !== undefined) data.transportMarkupRate = toDecimal(body.transportMarkupRate);
    if (body.referralBuyerReward !== undefined) data.referralBuyerReward = asMoney(body.referralBuyerReward);
    if (body.referralSupplierReward !== undefined) data.referralSupplierReward = asMoney(body.referralSupplierReward);
    if (body.reservationHours !== undefined) data.reservationHours = body.reservationHours;
    if (body.expiryCompensationRate !== undefined) data.expiryCompensationRate = toDecimal(body.expiryCompensationRate);

    const result = await tx.platformSetting.update({ where: { id: 1 }, data });

    // Audit limité aux champs réellement modifiés : la valeur d'un champ non
    // changé n'a pas à figer dans le journal. Comparaison par valeur pour les
    // Decimal (0 et 0.0 sont égaux) ; reservationHours est un Int, comparé par
    // égalité stricte.
    const before = {};
    const after = {};
    for (const [key, value] of Object.entries(data)) {
      const unchanged = value instanceof Prisma.Decimal ? value.equals(current[key]) : value === current[key];
      if (!unchanged) {
        before[key] = toNumber(current[key]);
        after[key] = toNumber(value);
      }
    }

    await recordAudit(tx, {
      actorUser: req.user,
      action: 'SETTINGS_UPDATED',
      entityType: 'PlatformSetting',
      entityId: 1,
      metadata: { before, after },
    });

    return result;
  });

  res.json(updated);
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
// Détail d'un document + token JWT signé de courte durée (10 minutes) pour
// accéder au fichier privé. Le token encode le chemin relatif du fichier
// (Media.publicId) et expire dans 10 minutes : passé ce délai,
// GET /api/v2/admin/files/:token rejettera la demande.
// Comportement identique à l'ancienne URL Cloudinary signée.
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
    // Génère un token JWT signé avec le chemin relatif du fichier.
    // Durée de vie : 10 minutes — identique à l'ancienne URL Cloudinary signée.
    // SECRET_FILE_TOKEN : clé dédiée aux tokens de fichiers privés.
    // Fallback sur JWT_SECRET si non définie (compatibilité environnements existants).
    const secret = process.env.SECRET_FILE_TOKEN ?? process.env.JWT_SECRET;
    const token = jwt.sign({ filePath: media.publicId }, secret, { expiresIn: '10m' });
    // L'URL est relative au serveur : le client frontal la préfixe avec l'URL de base.
    urlSignee = `/api/v2/admin/files/${token}`;
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

    // Parrainage (P6.1) : dans la MÊME transaction que la validation du profil.
    // Si le filleul a un Referral PENDING et que le parrain est vérifié, il passe
    // à ELIGIBLE. Si le parrain vient d'être vérifié, ses filleuls déjà vérifiés
    // dont le Referral est PENDING passent à ELIGIBLE.
    if (nouveauStatut === 'VERIFIED') {
      await onProfileVerified(tx, document.userId);
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

// GET /api/v2/admin/referrals?status=&page=&limit= — liste des parrainages
// (ADMIN et plus), paginée comme les autres listes.
//
// Le filtre porte sur le statut du parrainage (PENDING, ELIGIBLE, PAID, REJECTED).
// Chaque parrainage expose la référence de paiement (quand il est payé) et le
// compte de paiement par défaut du parrain : l'admin doit savoir où payer
// (numéro complet, comme la vue admin des reversements).
export const listReferrals = async (req, res) => {
  const { status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const where = status ? { status } : {};

  const [items, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: {
        referrer: {
          select: {
            id: true,
            firstname: true,
            lastname: true,
            email: true,
            payoutAccounts: {
              where: { isDefault: true },
              select: { method: true, provider: true, accountNumber: true, accountName: true },
            },
          },
        },
        referred: { select: { id: true, firstname: true, lastname: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.referral.count({ where }),
  ]);

  res.json({
    items: items.map((r) => ({
      id: r.id,
      referrer: r.referrer
        ? {
            id: r.referrer.id,
            firstname: r.referrer.firstname,
            lastname: r.referrer.lastname,
            email: r.referrer.email,
            // Compte de paiement par défaut du parrain (numero complet) : c'est
            // sur ce compte que la récompense est versée.
            defaultPayoutAccount: r.referrer.payoutAccounts[0] ?? null,
          }
        : null,
      referred: r.referred,
      kind: r.kind,
      status: r.status,
      rewardAmount: r.rewardAmount,
      eligibleAt: r.eligibleAt,
      reference: r.reference,
      paidById: r.paidById,
      paidAt: r.paidAt,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt,
    })),
    page,
    limit,
    total,
  });
};

// PATCH /api/v2/admin/referrals/:id/pay — ELIGIBLE -> PAID.
// Le parrainage ne peut être payé qu'une seule fois : un second paiement
// est un 409 (INVALID_STATE_TRANSITION).
export const payReferralController = async (req, res) => {
  const { reference } = req.body; // validé par payReferralSchema en amont

  const paid = await prisma.$transaction(async (tx) => {
    return payReferral(tx, req.params.id, {
      reference,
      actor: { user: req.user, agent: req.agent ?? null },
    });
  });

  res.json(paid);
};

// PATCH /api/v2/admin/referrals/:id/reject — PENDING ou ELIGIBLE -> REJECTED.
// Le motif est obligatoire : rejeter sans dire pourquoi priverait le parrain
// de toute correction possible.
export const rejectReferralController = async (req, res) => {
  const { reason } = req.body; // validé par rejectReferralSchema en amont

  const rejected = await prisma.$transaction(async (tx) => {
    return rejectReferral(tx, req.params.id, {
      reason,
      actor: { user: req.user, agent: req.agent ?? null },
    });
  });

  res.json(rejected);
};

// ---------------------------------------------------------------------------
// GET /api/v2/admin/files/:token
// ---------------------------------------------------------------------------
//
// Streaming sécurisé d'un fichier privé (document de vérification).
// Le token JWT (généré par getVerification, exp. 10 min) est validé ici.
// Le fichier est lu sur disque et streamé directement vers le client sans
// passer par express.static (les dossiers de documents ne sont pas montés
// statiquement).
//
// Sécurité :
//  - Seuls les membres du staff (protect + requireCapability) peuvent appeler
//    GET /verifications/:id, qui génère le token. Le token expire rapidement.
//  - path.resolve + vérification préfixe UPLOADS_ROOT : empêche toute
//    traversée de répertoire (/files/../../etc/passwd).
export const servePrivateFile = (req, res) => {
  const { token } = req.params;
  const secret = process.env.SECRET_FILE_TOKEN ?? process.env.JWT_SECRET;

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    // Token expiré, invalide ou altéré : on répond 401.
    return res.status(401).json({ error: 'Token de fichier invalide ou expiré' });
  }

  // payload.filePath est un chemin relatif du type "ID_CARD/20261018T142300_42_aB3x.jpg"
  const absPath = resolve(join(UPLOADS_ROOT, payload.filePath));

  // Protection contre la traversée de répertoire : le chemin résolu doit
  // rester dans UPLOADS_ROOT.
  const uploadsResolved = resolve(UPLOADS_ROOT);
  if (!absPath.startsWith(uploadsResolved + '/') && !absPath.startsWith(uploadsResolved + '\\')) {
    return res.status(400).json({ error: 'Chemin de fichier invalide' });
  }

  if (!existsSync(absPath)) {
    return res.status(404).json({ error: 'Fichier introuvable' });
  }

  // Le Content-Type est déduit de l'extension par Express/Node ; res.download()
  // forcerait un Content-Disposition: attachment, on préfère sendFile() pour
  // que le navigateur puisse afficher le PDF ou l'image en ligne.
  res.sendFile(absPath);
};


