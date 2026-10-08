import prisma from '../config/prisma.js';
import { uploadBufferToCloudinary } from '../utils/cloudinaryUpload.js';
import { getLookupId } from '../utils/lookupCache.js';
import { userToApi } from '../utils/userApi.js';
import { resetVerificationForNewEmail } from '../utils/emailVerification.js';

// Ces quatre routes vivaient sous /api/users et	y ont ete deplacees : un
// utilisateur qui gere son propre profil est, du point de vue de l'API, dans le
// meme registre que celui qui s'authentifie. /api/users reste libre pour les
// endpoints d'administration.

// GET /api/auth/me
export const getMe = async (req, res) => {
  const media = await prisma.media.findMany({ where: { ownerUserId: req.user.id } });
  res.json(userToApi(req.user, { media }));
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
