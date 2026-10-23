import { afterEach, describe, expect, it } from 'vitest';
import { getAiConfig, overrideAiConfigForTests } from '../../src/services/ai/ai.config.js';
import { getProvider } from '../../src/services/ai/provider.js';

describe('configuration IA', () => {
  afterEach(() => overrideAiConfigForTests(null));

  it('utilise les paramètres locaux par défaut', () => {
    overrideAiConfigForTests({ enabled: false, model: '' });
    expect(getAiConfig()).toMatchObject({
      enabled: false,
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 120000,
      numCtx: 4096,
      keepAlive: '10m',
      maxConcurrency: 1,
      autonomousEnabled: false,
      minConfidence: 0.8,
    });
  });

  it('exige un modèle lorsque le moteur est activé', () => {
    overrideAiConfigForTests({ enabled: true, model: '' });
    expect(() => getAiConfig()).toThrowError(expect.objectContaining({ code: 'AI_CONFIG_INVALID' }));
  });

  it('signale un fournisseur agent non pris en charge', () => {
    expect(() => getProvider({ aiProvider: 'cloud-future' })).toThrowError(
      expect.objectContaining({ code: 'AI_PROVIDER_UNSUPPORTED' }),
    );
  });
});
