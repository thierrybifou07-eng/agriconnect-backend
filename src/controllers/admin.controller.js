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
  isAvailable: true,
  vehicleType: true,
  createdAt: true,
};

// GET /api/admin/users?role=&search=&status=
// Note MySQL : pas de "mode: insensitive" (non supporté par ce connecteur Prisma).
export const listUsers = async (req, res) => {
  const { role, search, status } = req.query;

  const users = await prisma.user.findMany({
    where: {
      ...(role && { role: { code: role } }),
      ...(status && { userStatus: { code: status } }),
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

// POST /api/admin/users  (ROOT uniquement)
export const createAdmin = async (req, res) => {
  const { firstname, lastname, phone, email, password } = req.body;

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro' });
  }

  const [roleId, userStatusId] = await Promise.all([
    getLookupId('role', 'ADMIN'),
    getLookupId('userStatus', 'ACTIVE'),
  ]);

  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = await prisma.user.create({
    data: { firstname, lastname, phone, email, password: hashedPassword, roleId, userStatusId },
    select: userSafeSelect,
  });

  // Non-bloquant : l'email part apres la reponse, et ne peut pas faire echouer
  // la creation du compte. Aucune donnee sensible n'y figure.
  if (admin.email) {
    sendTemplateEmail(
      admin.email,
      'Votre compte administrateur AgriConnect',
      'welcome',
      { username: `${admin.firstname} ${admin.lastname}`, roleLabel: 'Administrateur' }
    );
  }

  res.status(201).json(admin);
};
