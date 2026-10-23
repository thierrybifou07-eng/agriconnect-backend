import { performance } from 'node:perf_hooks';
import { AiError } from './ai.error.js';
import { getAiConfig } from './ai.config.js';
import { recordAiLatency } from './ai.runtime.js';

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function request(url, init = {}) {
  const config = getAiConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new AiError('AI_INVALID_OUTPUT', 'Réponse Ollama invalide');
      }
    }
    if (!response.ok) {
      const missing = response.status === 404 || /model not found/i.test(body.error ?? '');
      throw new AiError(
        missing ? 'AI_MODEL_MISSING' : 'AI_UNREACHABLE',
        missing ? 'Le modèle Ollama demandé est introuvable' : 'Le service Ollama a refusé la requête',
      );
    }
    return body;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError('AI_UNREACHABLE', 'Le service Ollama est injoignable ou a dépassé le délai');
  } finally {
    clearTimeout(timer);
  }
}

const jsonRequest = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Ollama implementation of AiProvider. Prompt and response content is never logged.
 * @returns {import('./provider.js').AiProvider}
 */
export function createOllamaProvider(config = getAiConfig()) {
  return {
    async ping() {
      const start = performance.now();
      try {
        const body = await request(endpoint(config.baseUrl, '/api/tags'));
        recordAiLatency(Math.round(performance.now() - start));
        return {
          reachable: true,
          installedModels: Array.isArray(body.models) ? body.models.map(({ name }) => name).filter(Boolean) : [],
        };
      } catch (error) {
        if (error.code === 'AI_UNREACHABLE') {
          recordAiLatency(Math.round(performance.now() - start));
          return { reachable: false, installedModels: [] };
        }
        throw error;
      }
    },

    async describeModel() {
      if (!config.model) return { installed: false, capabilities: [], details: null };
      try {
        const body = await request(
          endpoint(config.baseUrl, '/api/show'),
          jsonRequest({ model: config.model }),
        );
        return {
          installed: true,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
          details: body.details ?? null,
        };
      } catch (error) {
        if (error.code === 'AI_MODEL_MISSING') return { installed: false, capabilities: [], details: null };
        throw error;
      }
    },

    async generateStructured({ system, user, schema, options = {} }) {
      if (!config.enabled) throw new AiError('AI_DISABLED', 'Le moteur IA est désactivé');
      if (!config.model) throw new AiError('AI_MODEL_MISSING', 'Aucun modèle Ollama n’est configuré');
      const start = performance.now();
      const body = await request(
        endpoint(config.baseUrl, '/api/chat'),
        jsonRequest({
          model: config.model,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          format: schema,
          options: { temperature: 0.2, num_ctx: config.numCtx, ...options },
          keep_alive: config.keepAlive,
        }),
      );
      const latencyMs = Math.round(performance.now() - start);
      recordAiLatency(latencyMs);
      let data;
      try {
        data = JSON.parse(body.message?.content);
      } catch {
        throw new AiError('AI_INVALID_OUTPUT', 'Ollama a renvoyé un JSON invalide');
      }
      return {
        data,
        latencyMs,
        promptTokens: Number.isFinite(body.prompt_eval_count) ? body.prompt_eval_count : null,
        completionTokens: Number.isFinite(body.eval_count) ? body.eval_count : null,
      };
    },
  };
}
