import { describe, it, expect } from 'vitest';
import { generateToken, verifyToken } from '../../src/utils/jwt.js';
import { generateRefreshTokenValue, hashToken } from '../../src/utils/refreshToken.js';

// process.env.JWT_SECRET est pose par tests/setup/env.js pour la suite
// integration ; ces tests unitaires tournent sans, on le definit donc ici.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-jwt';

describe('JWT', () => {
  it('encode et décode les charges utiles', () => {
    const token = generateToken({ id: 42, role: 'FARMER' });
    const decoded = verifyToken(token);
    expect(decoded.id).toBe(42);
    expect(decoded.role).toBe('FARMER');
  });

  it('applique une expiration', () => {
    process.env.JWT_EXPIRES_IN = '1h';
    const decoded = verifyToken(generateToken({ id: 1, role: 'BUYER' }));
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  // Un jeton signe avec une autre cle ne doit jamais etre accepte.
  it('refuse un jeton signe avec un autre secret', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const foreign = jwt.sign({ id: 1, role: 'ROOT' }, 'un-autre-secret');
    expect(() => verifyToken(foreign)).toThrow();
  });

  it('refuse un jeton dont la charge a ete modifiee', () => {
    const token = generateToken({ id: 1, role: 'BUYER' });
    const [header, payload, signature] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ id: 1, role: 'ROOT', iat: 1, exp: 9999999999 })
    ).toString('base64url');
    expect(() => verifyToken(`${header}.${tampered}.${signature}`)).toThrow();
  });
});

describe('RefreshToken', () => {
  it('produit des valeurs uniques et assez longues', () => {
    const values = new Set(Array.from({ length: 500 }, generateRefreshTokenValue));
    expect(values.size).toBe(500);
    expect([...values][0].length).toBeGreaterThanOrEqual(64);
  });

  // Le token brut ne doit jamais etre stocke : seule la empreinte l'est.
  it('hache de facon deterministe et irreversible', () => {
    const raw = generateRefreshTokenValue();
    const hash = hashToken(raw);
    expect(hash).toBe(hashToken(raw));
    expect(hash).not.toBe(raw);
    expect(hash).toHaveLength(64);
  });
});
