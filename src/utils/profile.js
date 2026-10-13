// Creation ou recuperation du profil d'un role.
//
// Les comptes crees avant P1.2 (inscription v2) n'ont pas de profil : les anciens
// FARMER devenus SUPPLIER n'ont jamais eu de SupplierProfile. Plutot que de les
// bloquer, on cree le profil a la volee avec les valeurs par defaut. register garde
// sa propre creation en transaction, il n'appelle pas cette fonction.

const MODELE_PAR_ROLE = {
  SUPPLIER: 'supplierProfile',
  BUYER: 'buyerProfile',
  DRIVER: 'driverProfile',
};

/**
 * Renvoie le profil du role, le cree s'il manque.
 *
 * SUPPLIER -> upsert de SupplierProfile (farmName = « prenom nom » a la creation).
 * BUYER    -> upsert de BuyerProfile (buyerType RETAILER).
 * DRIVER   -> ne cree rien : le profil exige une agence, absente ici. Sans profil,
 *             lève 409 PROFILE_MISSING.
 * ADMIN, AGENT, ROOT -> lève 403 : ces comptes n'ont pas de profil metier.
 *
 * Idempotent : un profil existant est renvoye tel quel, jamais ecrase.
 *
 * @param {object} db    Client Prisma (ou transaction).
 * @param {object} user  Utilisateur charge avec `role`.
 * @returns {Promise<object>} Le profil du role.
 */
export async function ensureProfile(db, user) {
  const modele = MODELE_PAR_ROLE[user.role.code];

  if (!modele) {
    throw Object.assign(new Error("Les comptes d'équipe n'ont pas de profil"), { statusCode: 403 });
  }

  const profil = await db[modele].findUnique({ where: { userId: user.id } });
  if (profil) return profil;

  // Un livreur sans DriverProfile n'a rattache a aucune agence : le profil ne
  // peut pas etre cree sans elle, on renvoie un code explicite au client.
  if (user.role.code === 'DRIVER') {
    throw Object.assign(new Error('Livreur sans agence : contactez un administrateur'), {
      statusCode: 409,
      code: 'PROFILE_MISSING',
    });
  }

  return db[modele].create({
    data: {
      userId: user.id,
      ...(user.role.code === 'SUPPLIER' && {
        farmName: `${user.firstname} ${user.lastname}`,
      }),
      ...(user.role.code === 'BUYER' && {
        buyerType: 'RETAILER',
      }),
    },
  });
}
