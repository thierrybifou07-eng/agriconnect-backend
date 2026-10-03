import { describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { parseAllowedOrigins, httpCorsOptions, socketCorsOptions } from '../../src/utils/cors.js';

// Un serveur Express minimal monte sur la configuration demandee, pour lire les
// en-tetes reellement emis. Tester la fonction seule ne prouverait rien : le
// defaut initial venait précisément d'un appel de bibliothèque correct sur une
// valeur mal interpretee, il fallait donc verifier le résultat observable.
const buildApp = (raw) => {
  const app = express();
  app.use(cors(httpCorsOptions(raw)));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  return app;
};

const ACAO = 'access-control-allow-origin';
const ACAC = 'access-control-allow-credentials';

describe('Lecture de CORS_IO', () => {
  // Les cas "variable absente" se testent avec une chaine vide et non sans
  // argument : sans argument la fonction lit process.env, dont la valeur
  // depend du projet Vitest qui execute le fichier. Ce cas est couvert plus
  // bas, en pilotant explicitement la variable.
  it('ne considere rien comme configure quand la variable est vide', () => {
    expect(parseAllowedOrigins('')).toEqual({ configured: false, all: false, origins: [] });
    expect(parseAllowedOrigins('   ')).toEqual({ configured: false, all: false, origins: [] });
  });

  it('reconnait le joker et ne le compte pas comme une origine nommee', () => {
    expect(parseAllowedOrigins('*')).toEqual({ configured: true, all: true, origins: [] });
  });

  it('decoupe une liste et ignore les espaces autour des virgules', () => {
    expect(parseAllowedOrigins('http://localhost:5173, https://agriconnect.ma')).toEqual({
      configured: true,
      all: false,
      origins: ['http://localhost:5173', 'https://agriconnect.ma'],
    });
  });

  // Une seule entrée parasite ne doit pas refermer la porte au joker : '*'
  // reste un joker quoi qu'il soit accompagne.
  it('traite le joker comme joker meme accompagne d\'une liste', () => {
    expect(parseAllowedOrigins('https://agriconnect.ma,*').all).toBe(true);
  });
});

describe('Configuration HTTP', () => {
  it('laisse le defaut ouvert quand rien n est configure', () => {
    expect(httpCorsOptions('')).toEqual({});
  });

  // Regressions : '*' doit ouvrir l'API. Et il ne peut pas etre transmis comme
  // une origine litterale, car aucun navigateur n'a une origine nommee '*' :
  // l'en-tete etait alors absent et toute requete cross-origin refusee.
  it('refleche l origine de la requete pour le joker', () => {
    expect(httpCorsOptions('*')).toEqual({ origin: true, credentials: true });
  });

  it('refuse le wildcard litteral, rejete par les navigateurs des que les identifiants sont autorises', () => {
    expect(httpCorsOptions('*').origin).not.toBe('*');
  });

  it('respecte une liste explicite', () => {
    expect(httpCorsOptions('http://localhost:5173')).toEqual({
      origin: ['http://localhost:5173'],
      credentials: true,
    });
  });

  it('lit la variable d\'environnement quand aucun parametre n est fourni', () => {
    const previous = process.env.CORS_IO;
    try {
      process.env.CORS_IO = 'https://agriconnect.ma';
      expect(httpCorsOptions().origin).toEqual(['https://agriconnect.ma']);
      process.env.CORS_IO = '*';
      expect(httpCorsOptions().origin).toBe(true);
      // Une variable absente de l'environnement doit se lire comme non
      // configuree, et non comme un joker.
      delete process.env.CORS_IO;
      expect(parseAllowedOrigins().configured).toBe(false);
      expect(httpCorsOptions()).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.CORS_IO;
      else process.env.CORS_IO = previous;
    }
  });
});

describe('Configuration Socket.io', () => {
  // Socket.io n'a pas la contrainte navigateur sur le wildcard, et garde donc
  // le joker litteral, mais doit suivre la meme liste que HTTP.
  it('laisse ouvert quand rien n est configure', () => {
    expect(socketCorsOptions('')).toEqual({ origin: '*' });
  });

  it('conserve le joker litteral', () => {
    expect(socketCorsOptions('*')).toEqual({ origin: '*' });
  });

  it('respecte une liste explicite', () => {
    expect(socketCorsOptions('http://localhost:5173')).toEqual({ origin: ['http://localhost:5173'] });
  });
});

describe('En-tetes reellement emis', () => {
  const ask = async (raw, origin) => {
    const res = await request(buildApp(raw)).get('/health').set('Origin', origin);
    return { acao: res.headers[ACAO] ?? null, acac: res.headers[ACAC] ?? null };
  };

  it('emet un en-tete d origine pour le joker, la ou il manquait', async () => {
    const { acao, acac } = await ask('*', 'http://localhost:3000');
    expect(acao).toBe('http://localhost:3000');
    expect(acac).toBe('true');
  });

  it('n est pas indifferent a l origine demandee, meme avec le joker', async () => {
    const premier = await ask('*', 'http://localhost:3000');
    const second = await ask('*', 'https://agriconnect.ma');
    expect(second.acao).toBe('https://agriconnect.ma');
    expect(second.acao).not.toBe(premier.acao);
  });

  it('n autorise que les origines listees', async () => {
    const autorisee = await ask('http://localhost:5173', 'http://localhost:5173');
    expect(autorisee.acao).toBe('http://localhost:5173');

    const etrangere = await ask('http://localhost:5173', 'https://site-pirate.example');
    expect(etrangere.acao).toBeNull();
  });

  it('laisse ouvert et sans identifiants quand rien n est configure', async () => {
    const { acao, acac } = await ask('', 'https://site-pirate.example');
    expect(acao).toBe('*');
    expect(acac).toBeNull();
  });
});