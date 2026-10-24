import { afterEach, describe, expect, it } from 'vitest';
import { getAiConfig, overrideAiConfigForTests } from '../../src/services/ai/ai.config.js';
import { getProvider } from '../../src/services/ai/provider.js';

describe('configuration IA', () => {
  afterEach(() => overrideAiConfigForTests(null));

  it('utilise les paramètres locaux par défaut', () => {
    overrideAiConfigForTests({ enabled: false, model: '' });
    expect(getAiConfig()).toMatchObject({
      enabled: false,
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 120000,
      numCtx: 4096,
      keepAlive: '10m',
      maxConcurrency: 1,
      autonomousEnabled: false,
      minConfidence: 0.8,
      maxRpm: 8,
      dailyBudget: 200,
      autoSuggestEnabled: false,
    });
  });

  it('exige un modèle lorsque le moteur est activé', () => {
    overrideAiConfigForTests({ enabled: true, model: '' });
    expect(() => getAiConfig()).toThrowError(expect.objectContaining({ code: 'AI_CONFIG_INVALID' }));
  });

  it('exige la clé et le modèle Gemini quand le fournisseur est activé', () => {
    overrideAiConfigForTests({ enabled: true, provider: 'gemini', gemini: { model: '', timeoutMs: 30000, maxOutputTokens: 1024 } });
    expect(() => getAiConfig()).toThrowError(expect.objectContaining({ code: 'AI_CONFIG_INVALID' }));
    overrideAiConfigForTests({ enabled: true, provider: 'gemini', gemini: { model: 'gemini-2.5-flash', timeoutMs: 30000, maxOutputTokens: 1024 }, GEMINI_API_KEY: 'secret' });
    expect(getAiConfig()).toMatchObject({ provider: 'gemini', gemini: { model: 'gemini-2.5-flash', hasKey: true } });
    expect(getAiConfig()).not.toHaveProperty('GEMINI_API_KEY');
  });

  it('signale un fournisseur agent non pris en charge', () => {
    expect(() => getProvider({ aiProvider: 'cloud-future' })).toThrowError(
      expect.objectContaining({ code: 'AI_PROVIDER_UNSUPPORTED' }),
    );
  });
});
