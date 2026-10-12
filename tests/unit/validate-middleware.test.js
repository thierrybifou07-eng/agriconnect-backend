import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Joi from 'joi';
import { validate } from '../../src/middlewares/validate.middleware.js';

// Sous Express 5, req.query est un accesseur sans setter : seule une vraie
// requête HTTP reproduit le cas. Un faux objet req n'aurait pas cet accesseur
// et ne prouverait rien.
function miniApp() {
  const app = express();
  app.get(
    '/recherche',
    validate(
      Joi.object({
        nombre: Joi.number().integer(),
        nom: Joi.string().trim(),
      }),
      'query'
    ),
    (req, res) => {
      res.json({ query: req.query });
    }
  );
  return app;
}

describe('validate — property query sous Express 5', () => {
  it('convertit les chaînes valides et supprime les champs inconnus', async () => {
    const res = await request(miniApp()).get('/recherche?nombre=5&nom=  maïs  &inconnu=1');

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ nombre: 5, nom: 'maïs' });
  });

  it('renvoie 400 avec details quand une valeur est invalide', async () => {
    const res = await request(miniApp()).get('/recherche?nombre=abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Données invalides');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0]).toMatchObject({ field: 'nombre' });
  });
});
