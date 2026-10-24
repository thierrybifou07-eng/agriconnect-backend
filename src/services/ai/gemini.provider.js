import { GoogleGenAI } from '@google/genai';
import { getAiConfig } from './ai.config.js';
import { AiError } from './ai.error.js';
import { recordAiLatency } from './ai.runtime.js';
import { getThrottle } from './ai.throttle.js';
import { redactClientBlocks } from './ai.redact.js';

function extractText(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text.length > 0) return response.text;
  const candidate = response?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? '').join('') ?? '';
  return candidate;
}

function getStatus(error) {
  if (error && typeof error === 'object') {
    return error.status ?? error.code ?? error?.response?.status ?? null;
  }
  return null;
}

function parseRetryAfter(error) {
  if (!error || typeof error !== 'object') return null;
  const explicit = error.retryDelay ?? error.retryAfterMs ?? error?.headers?.['retry-after'];
  if (typeof explicit === 'number') return explicit;
  if (typeof explicit === 'string' && /^\d+(?:\.\d+)?$/.test(explicit)) return Number(explicit) * 1000;
  if (typeof explicit === 'string' && /\d+ms/i.test(explicit)) return Number(explicit.replace(/[^\d.]/g, ''));
  return null;
}

function isNetworkError(error) {
  if (!(error instanceof Error)) return false;
  return /fetch|network|ECONNRESET|timed out|timeout|fetch failed/i.test(error.message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(task, timeoutMs) {
  if (timeoutMs <= 0) return task();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve(task({ abortSignal: controller.signal })).finally(() => clearTimeout(timer));
}

export function createGeminiProvider(config = getAiConfig(), { client } = {}) {
  const clientInstance = client ?? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? undefined });

  return {
    async ping() {
      if (!config.enabled) return { reachable: false, installedModels: [], authenticated: false };
      const modelName = config.gemini.model || config.model;
      if (!modelName) return { reachable: true, installedModels: [], authenticated: false };
      try {
        const response = await clientInstance.models.get({ model: modelName });
        const installedModels = response?.name ? [response.name] : [];
        return { reachable: true, installedModels, authenticated: true };
      } catch (error) {
        const status = getStatus(error);
        if (status === 401 || status === 403 || /api key.*valid|invalid api key|not valid/i.test(String(error?.message ?? ''))) {
          return { reachable: true, installedModels: [], authenticated: false };
        }
        if (status === 404) return { reachable: true, installedModels: [], authenticated: true };
        return { reachable: false, installedModels: [], authenticated: false };
      }
    },

    async describeModel() {
      const modelName = config.gemini.model || config.model;
      return {
        installed: Boolean(modelName),
        capabilities: [],
        details: { provider: 'gemini' },
      };
    },

    async generateStructured({ system, user, schema, options = {} }) {
      if (!config.enabled) throw new AiError('AI_DISABLED', 'Le moteur IA est désactivé');
      const modelName = config.gemini.model || config.model;
      if (!modelName) throw new AiError('AI_MODEL_MISSING', 'Aucun modèle Gemini n’est configuré');

      const throttle = getThrottle(config);
      const run = async () => {
        await throttle.acquire();
        const start = Date.now();
        const sanitizedUser = redactClientBlocks(user);
        const requestConfig = {
          systemInstruction: system,
          temperature: 0.2,
          maxOutputTokens: config.gemini.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          ...options,
        };

        const response = await withTimeout(
          async ({ abortSignal }) => {
            const requestOptions = { model: modelName, contents: sanitizedUser, config: { ...requestConfig, abortSignal } };
            return clientInstance.models.generateContent(requestOptions);
          },
          Number(config.gemini.timeoutMs ?? config.timeoutMs ?? 30000),
        );

        const finishReason = response?.candidates?.[0]?.finishReason ?? response?.finishReason ?? null;
        const blocked = response?.promptFeedback?.blockReason ?? null;
        if (blocked || (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS')) {
          throw new AiError('AI_INVALID_OUTPUT', 'La réponse Gemini a été bloquée ou filtrée');
        }

        const text = extractText(response);
        if (!text) {
          throw new AiError('AI_INVALID_OUTPUT', 'Réponse Gemini vide');
        }

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new AiError('AI_INVALID_OUTPUT', 'La réponse Gemini n’est pas un JSON valide');
        }

        const latencyMs = Date.now() - start;
        recordAiLatency(latencyMs);
        return {
          data,
          latencyMs,
          promptTokens: response?.usageMetadata?.promptTokenCount ?? null,
          completionTokens: response?.usageMetadata?.candidatesTokenCount ?? null,
        };
      };

      let attempts = 0;
      while (attempts < 3) {
        attempts += 1;
        try {
          return await run();
        } catch (error) {
          const status = getStatus(error);
          const message = String(error?.message ?? '');
          if (status === 429) {
            const retryAfter = parseRetryAfter(error) ?? 0;
            if (attempts === 1 && retryAfter <= 15000) {
              await sleep(Math.min(retryAfter || 1000, 15000));
              continue;
            }
            throw new AiError('AI_RATE_LIMITED', 'Quota Gemini dépassé', { retryAfterMs: retryAfter });
          }
          if (status === 401 || status === 403 || /api key.*valid|invalid api key|unauthorized|forbidden/i.test(message)) {
            throw new AiError('AI_AUTH_FAILED', 'La clé Gemini est invalide ou non autorisée');
          }
          if (status === 404 || /model.*not found|not found.*model/i.test(message)) {
            throw new AiError('AI_MODEL_MISSING', 'Le modèle Gemini demandé est introuvable');
          }
          if (status === 400 || /invalid.*json|blocked|safety|schema|response/i.test(message)) {
            throw new AiError('AI_INVALID_OUTPUT', 'La réponse Gemini est invalide');
          }
          if ((status === 500 || status === 503 || isNetworkError(error) || status === 0) && attempts < 3) {
            await sleep(attempts === 1 ? 1000 : 2000);
            continue;
          }
          if (status === 500 || status === 503 || isNetworkError(error) || status === 0) {
            throw new AiError('AI_UNREACHABLE', 'Le service Gemini est injoignable ou a dépassé le délai');
          }
          if (error instanceof AiError) throw error;
          throw new AiError('AI_UNREACHABLE', 'Le service Gemini est injoignable ou a dépassé le délai');
        }
      }
      throw new AiError('AI_UNREACHABLE', 'Le service Gemini est injoignable ou a dépassé le délai');
    },
  };
}
