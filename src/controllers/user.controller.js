import prisma from '../config/prisma.js';
import { uploadBufferToCloudinary } from '../utils/cloudinaryUpload.js';
import { getLookupId } from '../utils/lookupCache.js';
import { userToApi, payoutAccountToApi } from '../utils/userApi.js';
import { resetVerificationForNewEmail } from '../utils/emailVerification.js';

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
  return db[modele].findUnique({ where: { userId: user.id } });
}

// Modele de profil d'un role donne. requireRole (auth.routes.js) garantit que
// le role a un profil avant d'arriver ici : la cle existe toujours.
const profileModel = (roleCode) =>
  ({ SUPPLIER: 'supplierProfile', BUYER: 'buyerProfile', DRIVER: 'driverProfile' })[roleCode];

// GET /api/auth/me
export const getMe = async (req, res) => {
  const [media, profile] = await Promise.all([
    prisma.media.findMany({ where: { ownerUserId: req.user.id } }),
    loadRoleProfile(prisma, req.user),
  ]);
  res.json(userToApi(req.user, { media, profile }));
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
export const uploadAvatar = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucune image fournie (champ "avatar")' });
  }

  const [mediaTypeId, mimeTypeId] = await Promise.all([
    getLookupId('mediaType', 'IMAGE'),
    getLookupId('mimeType', req.file.mimetype),
  ]);

  const url = await uploadBufferToCloudinary(req.file.buffer);

  const media = await prisma.$transaction(async (tx) => {
    await tx.media.deleteMany({ where: { ownerUserId: req.user.id, mediaTypeId } });
    return tx.media.create({
      data: { ownerUserId: req.user.id, mediaTypeId, mimeTypeId, url, isPrimary: true },
    });
  });

  res.status(201).json(media);
};

// PATCH /api/auth/me/profile
//
// Le schema Joi applique depend du role (voir auth.routes.js) : le corps ne
// contient deja que les champs du profil du role, inutile de filtrer une
// seconde fois. Les comptes d equipe n ont pas de profil : requireRole les
// arrete en 403 avant d'ici.
export const updateMyProfile = async (req, res) => {
  const modele = profileModel(req.user.role.code);

  const profil = await prisma[modele].findUnique({ where: { userId: req.user.id } });
  if (!profil) {
    return res.status(404).json({ error: 'Profil introuvable' });
  }

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

  res.json(misAJour);
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
