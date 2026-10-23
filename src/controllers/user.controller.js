import prisma from '../config/prisma.js';
import {
  saveFile,
  deleteFile,
  deleteUnreferencedFiles,
  publicIdFromUrl,
  StorageKind,
} from '../services/storage.service.js';
import { getLookupId } from '../utils/lookupCache.js';
import { assertFileSignature } from '../utils/fileSignature.js';
import { userToApi, payoutAccountToApi } from '../utils/userApi.js';
import { resetVerificationForNewEmail } from '../utils/emailVerification.js';
import { ensureProfile } from '../utils/profile.js';
import { mediaToApi } from '../utils/dto/media.dto.js';
import { profileToApi } from '../utils/dto/profile.dto.js';
import { loadAgentForUser } from '../services/agent.service.js';
import { agentToClientDto } from '../utils/dto/agent.dto.js';

// Ces quatre routes vivaient sous /api/users et	y ont ete deplacees : un
// utilisateur qui gere son propre profil est, du point de vue de l'API, dans le
// meme registre que celui qui s'authentifie. /api/users reste libre pour les
// endpoints d'administration.

// Le profil vit dans une table par role. Les comptes d equipe (ADMIN, AGENT,
// ROOT) n en ont pas : /me renvoie alors profile: null plutot qu une erreur.
async function loadRoleProfile(db, user) {
  const modeles = { SUPPLIER: 'supplierProfile', BUYER: 'buyerProfile', DRIVER: 'driverProfile' };
  const modele = modeles[user.role.code];
  if (!modele) return null;
  const profile = await db[modele].findUnique({ where: { userId: user.id } });
  // Le profil passe par le DTO : les colonnes techniques (userId, dates)
  // et les objets liés ne sortent jamais de l'API.
  return profileToApi(profile, user.role.code);
}

// Modele de profil d'un role donne. requireRole (auth.routes.js) garantit que
// le role a un profil avant d'arriver ici : la cle existe toujours.
const profileModel = (roleCode) =>
  ({ SUPPLIER: 'supplierProfile', BUYER: 'buyerProfile', DRIVER: 'driverProfile' })[roleCode];

// GET /api/auth/me
export const getMe = async (req, res) => {
  const [media, profile, agent] = await Promise.all([
    prisma.media.findMany({ where: { ownerUserId: req.user.id } }),
    loadRoleProfile(prisma, req.user),
    req.user.role.code === 'AGENT' ? loadAgentForUser(req.user.id) : null,
  ]);
  res.json(userToApi(req.user, {
    media: media.map(mediaToApi),
    profile,
    agent: agentToClientDto(agent),
  }));
};

// PATCH /api/auth/me
export const updateMe = async (req, res) => {
  const { firstname, lastname, email, location } = req.body;

  // Changer d'adresse est un changement d'identite, pas une mise a jour de
  // profil : la verification repart de zero. Sans cela, il suffirait de changer
  // d'adresse pour hériter du verified=true de la précédente — sur une adresse
  // que l'on ne contrôle pas.
  const changementEmail = email !== undefined && email !== req.user.email;

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      // Les deux moities du nom sont optionnelles et independantes : un client
      // qui renvoie seulement "lastname" ne doit pas effacer le prenom.
      ...(firstname !== undefined && { firstname }),
      ...(lastname !== undefined && { lastname }),
      ...(email !== undefined && { email }),
      ...(location !== undefined && { location }),
    },
    include: { role: true, userStatus: true },
  });

  // Attendu : la reponse doit refleter la remise a zero, et non l'etat d'avant
  // le changement d'adresse. L'envoi, lui, ne bloque pas.
  const aRenvoyer = changementEmail
    ? await resetVerificationForNewEmail(updated)
    : updated;

  res.json(userToApi(aRenvoyer));
};

// POST /api/auth/me/avatar  (remplace l'avatar existant s'il y en avait un)
//
// Le remplacement porte sur deux supports : la ligne Media ET le fichier. La
// ligne part dans la transaction, avec la création de la nouvelle ; le fichier,
// lui, ne peut être supprimé qu'APRÈS le commit — le faire avant exposerait
// l'utilisateur à une image cassée si la transaction échouait. D'où cet ordre :
// contrôle du contenu, écriture, transaction, puis nettoyage au mieux.
export const uploadAvatar = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucune image fournie (champ "avatar")', code: 'FILE_REQUIRED' });
  }

  // Le type MIME est déclaré par le client : un .txt renommé en .jpg
  // passerait le filtre du middleware. On compare les octets de tête au type
  // déclaré avant toute écriture (FILE_CONTENT_MISMATCH, 400).
  assertFileSignature(req.file.buffer, req.file.mimetype);

  const [mediaTypeId, mimeTypeId] = await Promise.all([
    getLookupId('mediaType', 'IMAGE'),
    getLookupId('mimeType', req.file.mimetype),
  ]);

  // Les anciens avatars sont lus avant tout : leurs publicId sont nécessaires
  // après le commit, quand la transaction les aura supprimés de la base.
  const anciensAvatars = await prisma.media.findMany({
    where: { ownerUserId: req.user.id, mediaTypeId },
  });
  // Un média enregistré avant l'existence de la colonne publicId n'a qu'une URL :
  // on la dérive pour pouvoir supprimer le fichier lui aussi. La lecture ne
  // touche que les médias possédés par l'utilisateur (ownerUserId) : les
  // documents de vérification ont un propriétaire distinct et ne sont jamais
  // concernés.
  const anciensPublicIds = anciensAvatars
    .map((media) => media.publicId ?? publicIdFromUrl(media.url))
    .filter(Boolean);

  const { url, publicId } = await saveFile(req.file.buffer, {
    kind: StorageKind.AVATAR,
    userId: req.user.id,
    mimetype: req.file.mimetype,
  });

  let media;
  try {
    media = await prisma.$transaction(async (tx) => {
      await tx.media.deleteMany({ where: { ownerUserId: req.user.id, mediaTypeId } });
      return tx.media.create({
        data: { ownerUserId: req.user.id, mediaTypeId, mimeTypeId, url, publicId, isPrimary: true },
      });
    });
  } catch (err) {
    // La transaction a échoué : le nouveau fichier n'est référencé par aucune
    // ligne Media, il est donc orphelin. On le supprime avant de relancer
    // l'erreur d'origine — la compensation ne doit jamais la masquer.
    await deleteFile(publicId).catch((compensationErr) => {
      console.error('Suppression du fichier avatar impossible :', compensationErr);
    });
    throw err;
  }

  // Après le commit seulement : l'ancien avatar est déjà remplacé en base.
  // deleteUnreferencedFiles ne supprime le fichier que si plus aucune ligne
  // Media ne le référence. Un échec ici est une fuite disque, pas une perte de
  // donnée pour l'utilisateur : il est journalisé, jamais propagé.
  try {
    await deleteUnreferencedFiles(prisma, anciensPublicIds);
  } catch (err) {
    console.error("Suppression de l'ancien avatar impossible :", err);
  }

  // L'objet Media brut porte publicId, fileSize et les clés de référence :
  // seul le DTO d'affichage (URL, position, principale) est renvoyé.
  res.status(201).json(mediaToApi(media));
};

// PATCH /api/auth/me/profile
//
// Le schema Joi applique depend du role (voir auth.routes.js) : le corps ne
// contient deja que les champs du profil du role, inutile de filtrer une
// seconde fois. Les comptes d equipe n ont pas de profil : requireRole les
// arrete en 403 avant d'ici.
export const updateMyProfile = async (req, res) => {
  const modele = profileModel(req.user.role.code);

  // Un compte créé avant P1.2 n'a pas de profil : on le crée à la volée
  // plutôt que de répondre 404. Lève 403 pour les comptes d'équipe et
  // 409 PROFILE_MISSING pour un livreur sans agence.
  await ensureProfile(prisma, req.user);

  // Une zone inconnue vaut une requete mal formee : on la refuse avant
  // ecriture plutot que de laisser la contrainte de cle etrangerre lever une
  // erreur serveur. null signifie "retirer la zone", ce que la colonne
  // accepte : aucune verification n est alors necessaire.
  const { zoneId } = req.body;
  if (zoneId) {
    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(400).json({ error: 'Zone introuvable' });
    }
  }

  const misAJour = await prisma[modele].update({
    where: { userId: req.user.id },
    data: req.body,
  });

  res.json(profileToApi(misAJour, req.user.role.code));
};

// Comptes de paiement — GET /api/auth/me/payout-accounts
//
// Le numero n est jamais renvoye : payoutAccountToApi n expose que les quatre
// derniers caracteres (voir utils/userApi.js).
export const listPayoutAccounts = async (req, res) => {
  const comptes = await prisma.payoutAccount.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(comptes.map(payoutAccountToApi));
};

// POST /api/auth/me/payout-accounts
export const createPayoutAccount = async (req, res) => {
  const { method, provider, accountNumber, accountName, isDefault } = req.body;

  // Un seul compte par defaut : celui qui prend la place retire le flag du
  // precedent, dans la meme transaction que la creation. Sans cela, deux
  // comptes pourraient se croire defaut simultanement, et un paiement
  // partirait vers l un ou l autre selon l ordre des ecritures.
  const compte = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.payoutAccount.updateMany({
        where: { userId: req.user.id },
        data: { isDefault: false },
      });
    }
    return tx.payoutAccount.create({
      data: {
        userId: req.user.id,
        method,
        provider: provider ?? null,
        accountNumber,
        accountName: accountName ?? null,
        isDefault: isDefault ?? false,
      },
    });
  });

  res.status(201).json(payoutAccountToApi(compte));
};

// PATCH /api/auth/me/payout-accounts/:id
export const updatePayoutAccount = async (req, res) => {
  const compte = await prisma.payoutAccount.findFirst({
    where: { id: Number(req.params.id), userId: req.user.id },
  });
  // 404 et non 403 : dire qu un compte existe sans en etre le proprietaire
  // reviendrait a laisser un client lister les comptes des autres.
  if (!compte) {
    return res.status(404).json({ error: 'Compte introuvable' });
  }

  const { method, provider, accountNumber, accountName, isDefault } = req.body;

  const misAJour = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      // Le compte courant est exclu du retrait : il reprend le flag juste
      // apres, et un updateMany sans cette exclusion echouerait des qu il
      // s appliquerait a lui-meme.
      await tx.payoutAccount.updateMany({
        where: { userId: req.user.id, id: { not: compte.id } },
        data: { isDefault: false },
      });
    }
    return tx.payoutAccount.update({
      where: { id: compte.id },
      data: {
        ...(method !== undefined && { method }),
        ...(provider !== undefined && { provider }),
        ...(accountNumber !== undefined && { accountNumber }),
        ...(accountName !== undefined && { accountName }),
        ...(isDefault !== undefined && { isDefault }),
      },
    });
  });

  res.json(payoutAccountToApi(misAJour));
};

// DELETE /api/auth/me/payout-accounts/:id
export const deletePayoutAccount = async (req, res) => {
  const compte = await prisma.payoutAccount.findFirst({
    where: { id: Number(req.params.id), userId: req.user.id },
  });
  if (!compte) {
    return res.status(404).json({ error: 'Compte introuvable' });
  }

  await prisma.payoutAccount.delete({ where: { id: compte.id } });
  res.status(204).send();
};

// Nombre maximum de documents de vérification qu'un compte peut avoir en
// attente d'examen à la fois. Au-delà, les dépôts sont refusés (409) : la
// file de revue doit rester lisible par l'administrateur, et le plafond
// empêche de la noyer de dépôts redondants. Constante nommée : le nombre
// n'apparaît qu'ici et dans le message d'erreur.
const MAX_PENDING_VERIFICATION_DOCUMENTS = 5;

// POST /api/auth/me/documents
//
// Dépôt d'un document de vérification du profil. Le fichier est stocké en
// mode privé (hors du chemin express.static) : il n'est jamais servi
// publiquement, seul un jeton de courte durée le rend lisible par le staff.
export const submitDocument = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni (champ "file")', code: 'FILE_REQUIRED' });
  }

  const { type } = req.body; // validé par submitDocumentSchema en amont

  // Même raison que pour l'avatar : le MIME est déclaré par le client, les
  // octets de tête ne mentent pas. Contrôle avant l'écriture du fichier.
  assertFileSignature(req.file.buffer, req.file.mimetype);

  // Plafond de la file de revue : sans borne, un compte peut noyer
  // l'administrateur de dépôts identiques. Le refus précède l'écriture du
  // fichier : un dépôt refusé ne laisse rien sur le disque.
  const pending = await prisma.verificationDocument.count({
    where: { userId: req.user.id, status: 'PENDING' },
  });
  if (pending >= MAX_PENDING_VERIFICATION_DOCUMENTS) {
    return res.status(409).json({
      error: `Vous avez déjà ${MAX_PENDING_VERIFICATION_DOCUMENTS} documents en attente d'examen`,
      code: 'TOO_MANY_PENDING_DOCUMENTS',
    });
  }

  // Le mimeType doit exister en base (clé étrangère) : le middleware ne laisse
  // passer que les 4 types seedés, mais la lecture du mediaTypeId évite une
  // erreur serveur si la table de référence n'est pas peuplée.
  const mimeType = await prisma.mimeType.findUnique({ where: { code: req.file.mimetype } });
  if (!mimeType) {
    return res.status(400).json({ error: 'Type de fichier non supporté' });
  }

  // documentType : route le fichier vers le bon sous-dossier privé local
  // (ID_CARD/, BUSINESS_REGISTRATION/, FARM_PROOF/, OTHER/).
  const { url, publicId } = await saveFile(req.file.buffer, {
    kind: StorageKind.VERIFICATION_DOCUMENT,
    userId: req.user.id,
    mimetype: req.file.mimetype,
    documentType: type,
  });

  // Le fichier est écrit hors de la transaction : si celle-ci échoue, il
  // devient orphelin et ecrits permet de le supprimer avant de remonter l'erreur.
  const ecrits = [publicId];

  let document;
  try {
    document = await prisma.$transaction(async (tx) => {
      const doc = await tx.verificationDocument.create({
        data: { userId: req.user.id, type },
      });
      await tx.media.create({
        data: {
          ownerVerificationDocumentId: doc.id,
          mediaTypeId: mimeType.mediaTypeId,
          mimeTypeId: mimeType.id,
          url,
          publicId,
          isPrivate: true,
          fileSize: req.file.size,
        },
      });

      // Un nouveau dépôt relance l'examen : UNVERIFIED ou REJECTED repassent en
      // PENDING. Un compte déjà VERIFIED n'est pas dévérifié par un nouveau dépôt.
      const courant = await tx.user.findUnique({
        where: { id: req.user.id },
        select: { profileVerificationStatus: true },
      });
      if (courant.profileVerificationStatus === 'UNVERIFIED' || courant.profileVerificationStatus === 'REJECTED') {
        await tx.user.update({ where: { id: req.user.id }, data: { profileVerificationStatus: 'PENDING' } });
      }

      return doc;
    });
  } catch (err) {
    // Compensation : la transaction a été annulée, aucune ligne Media ne
    // référence le document. On le supprime avant de relancer l'erreur
    // d'origine, qui reste celle que le client doit voir.
    await Promise.allSettled(ecrits.map((publicId) => deleteFile(publicId)));
    throw err;
  }

  // Réponse volontairement minimale : aucune URL (le fichier est privé, seule
  // une URL signée de courte durée est délivrée au staff).
  res.status(201).json({
    id: document.id,
    type: document.type,
    status: document.status,
    note: document.note,
    createdAt: document.createdAt,
  });
};

// GET /api/auth/me/documents
//
// Liste des documents déposés, sans aucune URL : un document de vérification
// est privé, le propriétaire n'a pas à se renvoyer son propre fichier.
export const listMyDocuments = async (req, res) => {
  const documents = await prisma.verificationDocument.findMany({
    where: { userId: req.user.id },
    select: { id: true, type: true, status: true, note: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(documents);
};

// GET /api/auth/me/referral — parrainage de l'utilisateur connecté.
//
// Le parrain ne voit que le prénom de ses filleuls : c'est la donnée minimale
// pour reconnaître la personne, sans exposer son nom, son email ou son téléphone.
// Le montant de la récompense est figé au moment du passage à ELIGIBLE : il
// n'est pas recalculé si PlatformSetting change ensuite.
export const getMyReferral = async (req, res) => {
  const referrals = await prisma.referral.findMany({
    where: { referrerId: req.user.id },
    include: { referred: { select: { firstname: true } } },
    orderBy: { createdAt: 'desc' },
  });

  // Totaux par statut : le client affiche ces compteurs sans avoir à
  // recalculer la liste à chaque affichage.
  const totals = { pending: 0, eligible: 0, paid: 0 };
  for (const r of referrals) {
    if (r.status === 'PENDING') totals.pending++;
    else if (r.status === 'ELIGIBLE') totals.eligible++;
    else if (r.status === 'PAID') totals.paid++;
  }

  res.json({
    code: req.user.referralCode,
    totals,
    referrals: referrals.map((r) => ({
      status: r.status,
      kind: r.kind,
      rewardAmount: r.rewardAmount,
      createdAt: r.createdAt,
      referredFirstname: r.referred.firstname,
    })),
  });
};
