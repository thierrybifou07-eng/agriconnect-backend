import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { backfillProfiles } from '../../scripts/backfill-profiles.js';
import { createUser } from '../helpers/factory.js';

// Backfill des profils manquants : les comptes crees avant P1.2 (inscription v2)
// n'ont ni SupplierProfile ni BuyerProfile. Le script les cree avec --apply, ou
// se contente de les compter en mode simulation.

describe('backfill-profiles', () => {
  it('simulation : compte les profils manquants sans rien ecrire', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    const buyer = await createUser({ role: 'BUYER' });

    const resultat = await backfillProfiles({ apply: false });

    expect(resultat.simulation).toBe(true);
    expect(resultat.fournisseurs).toBe(1);
    expect(resultat.acheteurs).toBe(1);
    expect(resultat.livreurs).toBe(0);
    expect(resultat.crees).toBe(0);

    // Aucune ecriture : les profils nexistent toujours pas.
    expect(await prisma.supplierProfile.findUnique({ where: { userId: supplier.id } })).toBeNull();
    expect(await prisma.buyerProfile.findUnique({ where: { userId: buyer.id } })).toBeNull();
  });

  it('apply : cree les profils manquants avec les valeurs par defaut', async () => {
    const supplier = await createUser({ role: 'SUPPLIER', firstname: 'Karim', lastname: 'Haddad' });
    const buyer = await createUser({ role: 'BUYER' });

    const resultat = await backfillProfiles({ apply: true });

    expect(resultat.simulation).toBe(false);
    expect(resultat.fournisseurs).toBe(1);
    expect(resultat.acheteurs).toBe(1);
    expect(resultat.crees).toBe(2);

    const profilSupplier = await prisma.supplierProfile.findUnique({ where: { userId: supplier.id } });
    expect(profilSupplier).toBeTruthy();
    expect(profilSupplier.farmName).toBe('Karim Haddad');

    const profilBuyer = await prisma.buyerProfile.findUnique({ where: { userId: buyer.id } });
    expect(profilBuyer).toBeTruthy();
    expect(profilBuyer.buyerType).toBe('RETAILER');
  });

  it('apply idempotent : un second appel cree 0 profil', async () => {
    await createUser({ role: 'SUPPLIER' });
    await createUser({ role: 'BUYER' });

    const premier = await backfillProfiles({ apply: true });
    expect(premier.crees).toBe(2);

    const second = await backfillProfiles({ apply: true });
    expect(second.simulation).toBe(false);
    expect(second.fournisseurs).toBe(0);
    expect(second.acheteurs).toBe(0);
    expect(second.crees).toBe(0);
  });

  it('compte deja profile : inchange par le backfill', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    await prisma.supplierProfile.create({
      data: { userId: supplier.id, farmName: 'Ferme existante' },
    });

    const resultat = await backfillProfiles({ apply: true });

    expect(resultat.fournisseurs).toBe(0);
    expect(resultat.crees).toBe(0);

    const enBase = await prisma.supplierProfile.findUnique({ where: { userId: supplier.id } });
    expect(enBase.farmName).toBe('Ferme existante');
  });

  it('driver sans profil : liste, jamais cree', async () => {
    const driver = await createUser({ role: 'DRIVER' });

    const resultat = await backfillProfiles({ apply: true });

    expect(resultat.livreurs).toBe(1);
    expect(resultat.crees).toBe(0);
    expect(await prisma.driverProfile.findUnique({ where: { userId: driver.id } })).toBeNull();
  });
});
