import { AiError } from './ai.error.js';
import { getAiConfig } from './ai.config.js';
import { getProvider, resolveProviderName } from './provider.js';
import { SYSTEM_SUPPORT_FR } from './ai.prompts.js';
import { supportReplySchema } from './ai.schemas.js';
import { parseAndValidateSupportOutput } from './ai.guard.js';
import { getLastAiLatencyMs } from './ai.runtime.js';
import { getThrottle } from './ai.throttle.js';

const escapePromptData = (value) => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function getAiStatus(req, res) {
  const config = getAiConfig();
  const providerName = resolveProviderName();
  const provider = getProvider();
  const health = await provider.ping();
  let model = { installed: false, capabilities: [], details: null };
  const modelName = providerName === 'gemini' ? config.gemini.model || config.model : config.model;
  if (health.reachable && modelName) model = await provider.describeModel();

  res.json({
    enabled: config.enabled,
    provider: providerName,
    baseUrl: providerName === 'ollama' ? config.baseUrl : null,
    model: modelName,
    reachable: health.reachable,
    modelInstalled: model.installed,
    authenticated: health.authenticated ?? null,
    capabilities: model.capabilities,
    lastLatencyMs: getLastAiLatencyMs(),
    queue: { pending: 0, running: 0 },
    autonomousEnabled: config.autonomousEnabled,
    quota: providerName === 'gemini' ? getThrottle(config).getSnapshot() : null,
  });
}

export async function testAiProvider(req, res) {
  const config = getAiConfig();
  if (!config.enabled) {
    return res.status(409).json({ error: 'Le moteur IA est désactivé', code: 'AI_DISABLED' });
  }
  try {
    const provider = getProvider();
    const generated = await provider.generateStructured({
      system: SYSTEM_SUPPORT_FR,
      user: `<contexte>Test local du fournisseur IA. Aucun fait client n’est fourni.</contexte>\n<message_client>${escapePromptData(req.body?.prompt ?? 'Répondez poliment que le test du moteur local fonctionne.')}</message_client>`,
      schema: supportReplySchema,
    });
    const guarded = parseAndValidateSupportOutput(generated.data, { allowedNumbers: new Set() });
    return res.json({ ok: true, latencyMs: generated.latencyMs, output: { ...guarded.data, warnings: guarded.warnings } });
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    const status = error.code === 'AI_DISABLED' ? 409 : error.code === 'AI_RATE_LIMITED' ? 429 : 502;
    const payload = { error: error.message, code: error.code };
    if (error.retryAfterMs !== null && error.retryAfterMs !== undefined) payload.retryAfterMs = error.retryAfterMs;
    return res.status(status).json(payload);
  }
}
