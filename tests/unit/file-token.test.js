import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  FILE_TOKEN_AUDIENCE,
  FILE_TOKEN_PURPOSE,
  assertFileTokenSecret,
  signFileToken,
  verifyFileToken,
} from '../../src/utils/fileToken.js';
import { generateToken } from '../../src/utils/jwt.js';

const SECRET_JWT = 'secret-tests-jwt';
const SECRET_FICHIERS = 'secret-tests-fichiers';

// Remplace des variables d'environnement le temps du test et rend leur valeur
// initiale. `undefined` supprime la variable (c'est le cas qui compte pour
// SECRET_FILE_TOKEN).
function avecEnv(valeurs) {
  const sauvegarde = {};
  for (const [cle, valeur] of Object.entries(valeurs)) {
    sauvegarde[cle] = process.env[cle];
    if (valeur === undefined) delete process.env[cle];
    else process.env[cle] = valeur;
  }
  return () => {
    for (const [cle, valeur] of Object.entries(sauvegarde)) {
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
    }
  };
}

const restaure = [];
function env(valeurs) {
  const rendre = avecEnv({ JWT_SECRET: SECRET_JWT, ...valeurs });
  restaure.push(rendre);
  return rendre;
}

afterEach(() => {
  while (restaure.length) restaure.pop()();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('signFileToken / verifyFileToken', () => {
  it('signe un jeton lié au Media et au membre du staff, valable 10 minutes', () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS });

    const token = signFileToken({ mediaId: 42, staffUserId: 7 });

    const payload = verifyFileToken(token);
    expect(payload).toMatchObject({ purpose: FILE_TOKEN_PURPOSE, mediaId: 42, sub: '7' });
    expect(payload.aud).toBe(FILE_TOKEN_AUDIENCE);
    expect(payload.exp - payload.iat).toBe(10 * 60);

    // Aucun chemin disque dans le jeton : c'est la seule façon d'y cacher un
    // chemin arbitraire.
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'mediaId', 'purpose', 'sub']);
  });

  it('signe avec SECRET_FILE_TOKEN, jamais avec le secret des jetons d’accès', () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS });
    const token = signFileToken({ mediaId: 1, staffUserId: 1 });

    // Lisible par le secret dédié...
    expect(() => jwt.verify(token, SECRET_FICHIERS)).not.toThrow();
    // ...et pas par celui des jetons d'accès : les deux jetons ne sont pas
    // interchangeables.
    expect(() => jwt.verify(token, SECRET_JWT)).toThrow();
  });

  it('refuse un jeton d’accès normal utilisé comme jeton de fichier', () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS });

    const tokenAcces = generateToken({ id: 7, role: 'ADMIN' });

    expect(() => verifyFileToken(tokenAcces)).toThrow();
  });

  it('refuse un jeton expiré', () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS });
    const expire = jwt.sign(
      { purpose: FILE_TOKEN_PURPOSE, mediaId: 1, sub: '1' },
      SECRET_FICHIERS,
      { audience: FILE_TOKEN_AUDIENCE, expiresIn: '-1s' }
    );

    expect(() => verifyFileToken(expire)).toThrow();
  });

  it('refuse une finalité autre que private-file', () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS });
    const autre = jwt.sign(
      { purpose: 'autre-chose', mediaId: 1, sub: '1' },
      SECRET_FICHIERS,
      { audience: FILE_TOKEN_AUDIENCE, expiresIn: '10m' }
    );

    expect(() => verifyFileToken(autre)).toThrow(/finalité/);
  });
});

describe('Secret des jetons de fichier', () => {
  it('replie sur JWT_SECRET hors production, avec un seul avertissement', async () => {
    env({ SECRET_FILE_TOKEN: undefined, NODE_ENV: 'test' });
    const avertissement = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { signFileToken: signer } = await import('../../src/utils/fileToken.js');

    signer({ mediaId: 3, staffUserId: 3 });
    signer({ mediaId: 4, staffUserId: 4 });

    expect(avertissement).toHaveBeenCalledTimes(1);
    expect(avertissement.mock.calls[0][0]).toContain('SECRET_FILE_TOKEN');
  });

  it('n’émet aucun avertissement quand le secret dédié est défini', async () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS });
    const avertissement = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { signFileToken: signer } = await import('../../src/utils/fileToken.js');

    signer({ mediaId: 5, staffUserId: 5 });

    expect(avertissement).not.toHaveBeenCalled();
  });

  it('refuse de démarrer en production sans secret dédié', () => {
    env({ SECRET_FILE_TOKEN: undefined, NODE_ENV: 'production' });

    expect(() => assertFileTokenSecret()).toThrow(/SECRET_FILE_TOKEN est obligatoire/);
  });

  it('refuse de démarrer en production si le secret dédié est celui des accès', () => {
    env({ SECRET_FILE_TOKEN: SECRET_JWT, NODE_ENV: 'production' });

    expect(() => assertFileTokenSecret()).toThrow(/différent de JWT_SECRET/);
  });

  it('accepte en production un secret dédié distinct', () => {
    env({ SECRET_FILE_TOKEN: SECRET_FICHIERS, NODE_ENV: 'production' });

    expect(() => assertFileTokenSecret()).not.toThrow();
  });

  it('ne bloque rien hors production', () => {
    env({ SECRET_FILE_TOKEN: undefined, NODE_ENV: 'development' });

    expect(() => assertFileTokenSecret()).not.toThrow();
  });
});