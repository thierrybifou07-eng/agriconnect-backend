import { describe, it, expect } from 'vitest';
import {
  listVerificationsQuerySchema,
  reviewVerificationSchema,
} from '../../src/validators/verification.validator.js';

// Mêmes options que le middleware (src/middlewares/validate.middleware.js) :
// une requête HTTP renvoie toutes les erreurs d'un coup et perd les paramètres
// inconnus. Le schéma est testé avec elles, sinon un test passerait ici et
// échouerait sur la route.
const OPTIONS = { abortEarly: false, stripUnknown: true };

// validateAsync rejette au lieu de renvoyer { error } : on enveloppe pour lire
// la valeur OU l'erreur, comme le middleware qui traite les deux.
async function valider(schema, query) {
  try {
    return { value: await schema.validateAsync(query, OPTIONS), error: null };
  } catch (error) {
    return { value: undefined, error };
  }
}

const liste = (query) => valider(listVerificationsQuerySchema, query);
const decision = (body) => valider(reviewVerificationSchema, body);

describe('listVerificationsQuerySchema — filtres de la file de revue', () => {
  it('applique page 1 et limit 20 quand rien n est fourni', async () => {
    const { value } = await liste({});

    expect(value).toEqual({ page: 1, limit: 20 });
  });

  it('accepte les filtres status, type, role et userId', async () => {
    const { value } = await liste({
      status: 'PENDING',
      type: 'BUSINESS_REGISTRATION',
      role: 'SUPPLIER',
      userId: '42',
      page: '3',
      limit: '50',
    });

    // Les paramètres de requête arrivent en chaînes : le schéma les convertit,
    // sinon Prisma recevrait « 3 » là où il attend un entier.
    expect(value).toEqual({
      status: 'PENDING',
      type: 'BUSINESS_REGISTRATION',
      role: 'SUPPLIER',
      userId: 42,
      page: 3,
      limit: 50,
    });
  });

  it('accepte les bornes de pagination', async () => {
    expect((await liste({ page: '1', limit: '1' })).value).toMatchObject({ page: 1, limit: 1 });
    expect((await liste({ page: '999', limit: '100' })).value).toMatchObject({ page: 999, limit: 100 });
  });

  it('refuse une pagination hors bornes', async () => {
    // limit=0 donnerait une page vide, limit=10000 ferait sortir toute la
    // file d'un coup : les deux sont des erreurs de requête, pas des valeurs
    // à corriger en silence.
    for (const limit of ['0', '-1', '101', 'abc']) {
      const { error } = await liste({ limit });
      expect(error, `limit=${limit} devrait être refusé`).toBeTruthy();
    }

    expect((await liste({ page: '0' })).error).toBeTruthy();
    expect((await liste({ page: '1.5' })).error).toBeTruthy();
  });

  it('refuse un statut, un type ou un rôle inconnu', async () => {
    for (const query of [{ status: 'APPROVED' }, { type: 'PASSEPORT' }, { role: 'ADMIN' }, { role: 'AGENT' }]) {
      const { error } = await liste(query);
      expect(error, `${JSON.stringify(query)} devrait être refusé`).toBeTruthy();
    }
  });

  it('refuse un userId qui n est pas un entier positif', async () => {
    for (const userId of ['0', '-3', 'abc', '1.5']) {
      const { error } = await liste({ userId });
      expect(error, `userId=${userId} devrait être refusé`).toBeTruthy();
    }
  });

  it('supprime un paramètre inconnu au lieu de le laisser passer', async () => {
    const { value } = await liste({ tri: 'createdAt', page: '2' });

    expect(value).toEqual({ page: 2, limit: 20 });
  });
});

describe('reviewVerificationSchema — décision d examen', () => {
  it('accepte une approbation sans note', async () => {
    const { value } = await decision({ decision: 'APPROVE' });

    expect(value).toEqual({ decision: 'APPROVE' });
  });

  it('exige une note pour un rejet', async () => {
    const { error } = await decision({ decision: 'REJECT' });

    expect(error).toBeTruthy();
  });

  it('refuse une décision inconnue', async () => {
    const { error } = await decision({ decision: 'PEUT-ETRE' });

    expect(error).toBeTruthy();
  });
});