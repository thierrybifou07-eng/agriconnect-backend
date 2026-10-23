import { AiError } from './ai.error.js';
import { getAiConfig } from './ai.config.js';
import { getProvider } from './provider.js';
import { SYSTEM_SUPPORT_FR } from './ai.prompts.js';
import { supportReplySchema } from './ai.schemas.js';
import { parseAndValidateSupportOutput } from './ai.guard.js';
import { getLastAiLatencyMs } from './ai.runtime.js';

const escapePromptData = (value) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function getAiStatus(req, res) {
  const config = getAiConfig();
  const provider = getProvider();
  const health = await provider.ping();
  let model = { installed: false, capabilities: [], details: null };
  if (health.reachable && config.model) model = await provider.describeModel();

  res.json({
    enabled: config.enabled,
    provider: 'ollama',
    baseUrl: config.baseUrl,
    model: config.model,
    reachable: health.reachable,
    modelInstalled: model.installed,
    capabilities: model.capabilities,
    lastLatencyMs: getLastAiLatencyMs(),
    queue: { pending: 0, running: 0 },
    autonomousEnabled: config.autonomousEnabled,
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
    const status = error.code === 'AI_DISABLED' ? 409 : 502;
    return res.status(status).json({ error: error.message, code: error.code });
  }
}
