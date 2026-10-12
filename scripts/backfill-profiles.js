import prisma from '../src/config/prisma.js';
import { getLookupId } from '../src/utils/lookupCache.js';

// Backfill des profils manquants : les comptes crees avant P1.2 (inscription v2)
// n'ont ni SupplierProfile ni BuyerProfile. Ce script les cree, ou se contente
// de les compter en mode simulation (sans --apply).
//
// Les DRIVER sans DriverProfile sont listes mais jamais crees : le profil exige
// une agence, absente ici. L'utilisateur doit contacter un administrateur.
//
// Idempotent : un second appel avec --apply cree 0 profil.

/**
 * @param {object} options
 * @param {boolean} options.apply  false = simulation (aucune ecriture).
 * @returns {Promise<{ simulation: boolean, fournisseurs: number, acheteurs: number, livreurs: number, crees: number }>}
 */
export async function backfillProfiles({ apply }) {
  const [supplierRoleId, buyerRoleId, driverRoleId] = await Promise.all([
    getLookupId('role', 'SUPPLIER'),
    getLookupId('role', 'BUYER'),
    getLookupId('role', 'DRIVER'),
  ]);

  const utilisateurs = await prisma.user.findMany({
    where: { roleId: { in: [supplierRoleId, buyerRoleId, driverRoleId] } },
    include: { supplierProfile: true, buyerProfile: true, driverProfile: true },
    orderBy: { id: 'asc' },
  });

  const manquants = { fournisseurs: [], acheteurs: [], livreurs: [] };
  for (const u of utilisateurs) {
    if (u.roleId === supplierRoleId && !u.supplierProfile) manquants.fournisseurs.push(u);
    if (u.roleId === buyerRoleId && !u.buyerProfile) manquants.acheteurs.push(u);
    if (u.roleId === driverRoleId && !u.driverProfile) manquants.livreurs.push(u);
  }

  if (!apply) {
    console.log('Simulation (aucune ecriture) :');
    console.log(`  SUPPLIER sans profil : ${manquants.fournisseurs.length}`);
    for (const u of manquants.fournisseurs) {
      console.log(`    #${u.id} ${u.email} — farmName « ${u.firstname} ${u.lastname} »`);
    }
    console.log(`  BUYER sans profil : ${manquants.acheteurs.length}`);
    for (const u of manquants.acheteurs) {
      console.log(`    #${u.id} ${u.email} — buyerType « RETAILER »`);
    }
    console.log(`  DRIVER sans profil : ${manquants.livreurs.length} (listes, jamais crees)`);
    for (const u of manquants.livreurs) {
      console.log(`    #${u.id} ${u.email}`);
    }
    return {
      simulation: true,
      fournisseurs: manquants.fournisseurs.length,
      acheteurs: manquants.acheteurs.length,
      livreurs: manquants.livreurs.length,
      crees: 0,
    };
  }

  let crees = 0;
  for (const u of manquants.fournisseurs) {
    await prisma.supplierProfile.create({
      data: { userId: u.id, farmName: `${u.firstname} ${u.lastname}` },
    });
    crees += 1;
  }
  for (const u of manquants.acheteurs) {
    await prisma.buyerProfile.create({
      data: { userId: u.id, buyerType: 'RETAILER' },
    });
    crees += 1;
  }

  console.log(`Backfill terminé : ${crees} profil(s) créé(s).`);
  console.log(`  SupplierProfile : ${manquants.fournisseurs.length}`);
  console.log(`  BuyerProfile : ${manquants.acheteurs.length}`);
  console.log(`  DRIVER sans profil (listés, jamais créés) : ${manquants.livreurs.length}`);

  return {
    simulation: false,
    fournisseurs: manquants.fournisseurs.length,
    acheteurs: manquants.acheteurs.length,
    livreurs: manquants.livreurs.length,
    crees,
  };
}

// Execution directe : node scripts/backfill-profiles.js [--apply]
const estExecutionDirecte =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (estExecutionDirecte) {
  const apply = process.argv.includes('--apply');
  backfillProfiles({ apply })
    .then(() => process.exit(0))
    .catch((erreur) => {
      console.error(erreur);
      process.exit(1);
    });
}
