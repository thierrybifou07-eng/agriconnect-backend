import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

// Seed de développement : crée les données géographiques et logistiques
// nécessaires pour tester manuellement les flux de livraison (zone, agence,
// tarif, point de dépôt). N'est PAS exécuté par les tests : la base de test
// est reconstruite par migrate deploy + seed.js.
//
// Idempotent : chaque entité est relue avant écriture, donc le script peut
// tourner plusieurs fois sans erreur ni doublon.

async function main() {
  // Zone pilote
  const zone = await prisma.zone.upsert({
    where: { name: 'Zone pilote' },
    update: {},
    create: {
      name: 'Zone pilote',
      city: 'Ville pilote',
      region: 'Région pilote',
      isActive: true,
    },
  });

  // Agence de transport pilote (assurance fictive)
  const agency = await prisma.transportAgency.upsert({
    where: { name: 'Agence pilote' },
    update: {
      insuranceProvider: 'Assurance Fictive',
      insurancePolicyNumber: 'POL-FAKE-001',
      insuranceExpiresAt: new Date('2027-12-31T23:59:59.000Z'),
    },
    create: {
      name: 'Agence pilote',
      contactName: 'Contact pilote',
      phone: '+237600000000',
      email: 'agence-pilote@example.com',
      insuranceProvider: 'Assurance Fictive',
      insurancePolicyNumber: 'POL-FAKE-001',
      insuranceExpiresAt: new Date('2027-12-31T23:59:59.000Z'),
      isActive: true,
    },
  });

  // Tarif de l'agence pour la zone pilote
  await prisma.agencyZone.upsert({
    where: { agencyId_zoneId: { agencyId: agency.id, zoneId: zone.id } },
    update: { baseFee: 500, perKmFee: 100, isActive: true },
    create: {
      agencyId: agency.id,
      zoneId: zone.id,
      baseFee: 500,
      perKmFee: 100,
      isActive: true,
    },
  });

  // Point de dépôt pilote
  const existingHub = await prisma.hub.findFirst({ where: { name: 'Hub pilote' } });
  const hubData = {
    name: 'Hub pilote',
    address: '123 Rue du Marché, Ville pilote',
    city: 'Ville pilote',
    latitude: 4.0511,
    longitude: 9.7679,
    zoneId: zone.id,
    acceptsDropoff: true,
    acceptsPickup: true,
    isActive: true,
  };
  if (existingHub) {
    await prisma.hub.update({ where: { id: existingHub.id }, data: hubData });
  } else {
    await prisma.hub.create({ data: hubData });
  }

  console.log('Seed dev terminé : Zone pilote, Agence pilote, AgencyZone et Hub créés.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
