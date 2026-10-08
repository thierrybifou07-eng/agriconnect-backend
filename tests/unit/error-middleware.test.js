import { describe, it, expect, vi, afterEach } from 'vitest';
import { errorHandler } from '../../src/middlewares/error.middleware.js';

// errorHandler est une fonction pure de middleware : on lui passe un faux
// objet reponse qui enregistre ce qu'il renvoie, sans serveur ni base.
function fausseReponse() {
  const res = {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

describe('errorHandler', () => {
  // errorHandler journalise l'erreur sur stderr : on neutralise ce bruit pour
  // que la sortie de la suite reste lisible.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renvoie code quand l erreur en porte un', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fausseReponse();

    errorHandler(
      Object.assign(new Error('Stock insuffisant'), { statusCode: 409, code: 'INSUFFICIENT_STOCK' }),
      {},
      res,
      () => {}
    );

    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Stock insuffisant', code: 'INSUFFICIENT_STOCK' });
  });

  it('repond sans code quand l erreur n en porte pas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fausseReponse();

    errorHandler(new Error('Route non trouvee'), {}, res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Route non trouvee' });
  });

  // Un code non chaine (objet, nombre) ne doit pas fuiter dans la reponse :
  // le champ n'existe que pour les codes stables comparables par le client.
  it('ignore un code qui n est pas une chaine', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fausseReponse();

    errorHandler(Object.assign(new Error('Echec'), { statusCode: 400, code: 42 }), {}, res, () => {});

    expect(res.body).toEqual({ error: 'Echec' });
  });
});
