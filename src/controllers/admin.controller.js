import bcrypt from 'bcrypt';
import prisma from '../config/prisma.js';
import { getLookupId } from '../utils/lookupCache.js';
import { closeAllSessions } from '../utils/session.js';
import { emitSessionRevoked } from '../sockets/revocation.js';
// Meme pile que l inscription (src/config/email) : un seul moteur de rendu,
// une seule configuration SMTP.
import { sendTemplateEmail } from '../config/email/sendMail.js';

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
