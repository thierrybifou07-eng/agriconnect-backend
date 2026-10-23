import { describe, expect, it } from 'vitest';
import { parseAndValidateSupportOutput, validateSupportOutput } from '../../src/services/ai/ai.guard.js';

const valid = (reply, overrides = {}) => ({
  intent: 'PRODUCT_QUESTION',
  language: 'fr',
  confidence: 0.9,
  needs_human: false,
  reply,
  reasons: [],
  ...overrides,
});

describe('validateSupportOutput', () => {
  it('marque comme humain un nombre absent des faits autorisés', () => {
    const result = validateSupportOutput(valid('Le prix est de 900 XAF.'), { allowedNumbers: new Set(['600']) });

    expect(result.ok).toBe(true);
    expect(result.data.needs_human).toBe(true);
    expect(result.warnings).toContain('UNVERIFIED_NUMBER:900');
  });

  it.each([
    ['URL', 'Consultez https://example.com'],
    ['téléphone', 'Appelez le +237 699 123 456'],
    ['e-mail', 'Écrivez à aide@example.com'],
  ])('rejette une réponse contenant un %s', (_kind, reply) => {
    expect(validateSupportOutput(valid(reply)).ok).toBe(false);
  });

  it('tronque la réponse à 800 caractères', () => {
    const result = validateSupportOutput(valid('a'.repeat(820)));

    expect(result.ok).toBe(true);
    expect(result.data.reply).toHaveLength(800);
  });

  it('rejette un objet JSON invalide', () => {
    expect(validateSupportOutput('{')).toMatchObject({ ok: false, data: null });
    expect(() => parseAndValidateSupportOutput('{')).toThrowError(
      expect.objectContaining({ code: 'AI_INVALID_OUTPUT' }),
    );
  });
});
