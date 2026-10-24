import { describe, expect, it, vi } from 'vitest';
import { createGeminiProvider } from '../../src/services/ai/gemini.provider.js';
import { AiError } from '../../src/services/ai/ai.error.js';

describe('fournisseur Gemini', () => {
  it('retourne un JSON structuré lorsque la génération réussit', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({ intent: 'OTHER', language: 'fr', confidence: 0.9, needs_human: true, reply: 'OK', reasons: [] }),
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
      candidates: [{ finishReason: 'STOP' }],
    });
    const get = vi.fn().mockResolvedValue({ name: 'gemini-2.5-flash' });
    const provider = createGeminiProvider(
      {
        enabled: true,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        gemini: { model: 'gemini-2.5-flash', timeoutMs: 30000, maxOutputTokens: 512, hasKey: true },
        maxRpm: 8,
        dailyBudget: 200,
      },
      { client: { models: { get, generateContent } } },
    );

    const result = await provider.generateStructured({
      system: 'system',
      user: '<message_client>Bonjour</message_client>',
      schema: { type: 'object', properties: { intent: { type: 'string' } } },
    });

    expect(result.data.intent).toBe('OTHER');
    expect(result.promptTokens).toBe(12);
    expect(generateContent).toHaveBeenCalled();
  });

  it('renvoie AI_INVALID_OUTPUT si Gemini répond avec du JSON invalide', async () => {
    const provider = createGeminiProvider(
      {
        enabled: true,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        gemini: { model: 'gemini-2.5-flash', timeoutMs: 30000, maxOutputTokens: 512, hasKey: true },
        maxRpm: 8,
        dailyBudget: 200,
      },
      { client: { models: { get: vi.fn(), generateContent: vi.fn().mockResolvedValue({ text: '{oops' }) } } },
    );

    await expect(provider.generateStructured({
      system: 'system',
      user: 'test',
      schema: { type: 'object' },
    })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('transforme les erreurs de quota et d’authentification en codes métier', async () => {
    const provider = createGeminiProvider(
      {
        enabled: true,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        gemini: { model: 'gemini-2.5-flash', timeoutMs: 30000, maxOutputTokens: 512, hasKey: true },
        maxRpm: 8,
        dailyBudget: 200,
      },
      { client: { models: { get: vi.fn(), generateContent: vi.fn().mockRejectedValue({ status: 429, message: 'quota', retryDelay: 1000 }) } } },
    );

    await expect(provider.generateStructured({ system: 'system', user: 'test', schema: { type: 'object' } })).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });

    const authProvider = createGeminiProvider(
      {
        enabled: true,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        gemini: { model: 'gemini-2.5-flash', timeoutMs: 30000, maxOutputTokens: 512, hasKey: true },
        maxRpm: 8,
        dailyBudget: 200,
      },
      { client: { models: { get: vi.fn(), generateContent: vi.fn().mockRejectedValue({ status: 401, message: 'invalid api key' }) } } },
    );

    await expect(authProvider.generateStructured({ system: 'system', user: 'test', schema: { type: 'object' } })).rejects.toMatchObject({ code: 'AI_AUTH_FAILED' });
  });

  it('ping ne lève pas quand la clé est invalide', async () => {
    const provider = createGeminiProvider(
      { enabled: true, provider: 'gemini', model: 'gemini-2.5-flash', gemini: { model: 'gemini-2.5-flash', timeoutMs: 30000, maxOutputTokens: 512, hasKey: true }, maxRpm: 8, dailyBudget: 200 },
      { client: { models: { get: vi.fn().mockRejectedValue({ status: 401, message: 'API key not valid' }) } } },
    );

    await expect(provider.ping()).resolves.toMatchObject({ reachable: true, authenticated: false });
  });
});
