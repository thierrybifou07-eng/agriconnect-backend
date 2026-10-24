import 'dotenv/config';
import Joi from 'joi';

const envSchema = Joi.object({
  AI_ENABLED: Joi.boolean().default(false),
  AI_PROVIDER: Joi.string().valid('ollama', 'gemini').default('ollama'),
  OLLAMA_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: Joi.string().trim().when('AI_ENABLED', {
    is: true,
    then: Joi.when('AI_PROVIDER', {
      is: 'gemini',
      then: Joi.string().allow('').optional(),
      otherwise: Joi.string().min(1).required(),
    }),
    otherwise: Joi.string().allow('').default(''),
  }),
  OLLAMA_TIMEOUT_MS: Joi.number().integer().min(1).default(120000),
  OLLAMA_NUM_CTX: Joi.number().integer().min(1).default(4096),
  OLLAMA_KEEP_ALIVE: Joi.string().trim().min(1).default('10m'),
  AI_MAX_CONCURRENCY: Joi.number().integer().min(1).default(1),
  AI_AUTONOMOUS_ENABLED: Joi.boolean().default(false),
  AI_MIN_CONFIDENCE: Joi.number().min(0).max(1).default(0.8),
  AI_MAX_RPM: Joi.number().integer().min(1).default(8),
  AI_DAILY_BUDGET: Joi.number().integer().min(1).default(200),
  AI_AUTO_SUGGEST_ENABLED: Joi.boolean().default(false),
  GEMINI_API_KEY: Joi.string().trim().allow('').when('AI_ENABLED', {
    is: true,
    then: Joi.when('AI_PROVIDER', {
      is: 'gemini',
      then: Joi.string().trim().min(1).required(),
      otherwise: Joi.string().allow('').optional(),
    }),
    otherwise: Joi.string().allow('').optional(),
  }),
  GEMINI_MODEL: Joi.string().trim().when('AI_ENABLED', {
    is: true,
    then: Joi.when('AI_PROVIDER', {
      is: 'gemini',
      then: Joi.string().trim().min(1).required(),
      otherwise: Joi.string().allow('').optional(),
    }),
    otherwise: Joi.string().allow('').optional(),
  }),
  GEMINI_TIMEOUT_MS: Joi.number().integer().min(1).default(30000),
  GEMINI_MAX_OUTPUT_TOKENS: Joi.number().integer().min(1).default(1024),
}).unknown(true);

let testOverrides = {};

function applyTestOverrides(env) {
  const nextEnv = { ...env };
  const hasExplicitProvider = Object.hasOwn(testOverrides, 'provider');
  const hasOllamaSelection = ['model', 'baseUrl', 'timeoutMs', 'numCtx', 'keepAlive'].some((key) => Object.hasOwn(testOverrides, key));

  if (!hasExplicitProvider && hasOllamaSelection) {
    nextEnv.AI_PROVIDER = 'ollama';
  }

  for (const [key, value] of Object.entries(testOverrides)) {
    if (key === 'gemini' && value && typeof value === 'object') {
      for (const [geminiKey, geminiValue] of Object.entries(value)) {
        if (geminiKey === 'model') nextEnv.GEMINI_MODEL = geminiValue;
        if (geminiKey === 'timeoutMs') nextEnv.GEMINI_TIMEOUT_MS = geminiValue;
        if (geminiKey === 'maxOutputTokens') nextEnv.GEMINI_MAX_OUTPUT_TOKENS = geminiValue;
        if (geminiKey === 'hasKey') nextEnv.GEMINI_API_KEY = geminiValue ? (nextEnv.GEMINI_API_KEY || 'test-key') : '';
      }
      continue;
    }
    switch (key) {
      case 'provider': nextEnv.AI_PROVIDER = value; break;
      case 'enabled': nextEnv.AI_ENABLED = value; break;
      case 'baseUrl': nextEnv.OLLAMA_BASE_URL = value; break;
      case 'model': nextEnv.OLLAMA_MODEL = value; break;
      case 'timeoutMs': nextEnv.OLLAMA_TIMEOUT_MS = value; break;
      case 'numCtx': nextEnv.OLLAMA_NUM_CTX = value; break;
      case 'keepAlive': nextEnv.OLLAMA_KEEP_ALIVE = value; break;
      case 'maxConcurrency': nextEnv.AI_MAX_CONCURRENCY = value; break;
      case 'autonomousEnabled': nextEnv.AI_AUTONOMOUS_ENABLED = value; break;
      case 'minConfidence': nextEnv.AI_MIN_CONFIDENCE = value; break;
      case 'maxRpm': nextEnv.AI_MAX_RPM = value; break;
      case 'dailyBudget': nextEnv.AI_DAILY_BUDGET = value; break;
      case 'autoSuggestEnabled': nextEnv.AI_AUTO_SUGGEST_ENABLED = value; break;
      default: nextEnv[key] = value;
    }
  }

  if (!nextEnv.AI_PROVIDER) nextEnv.AI_PROVIDER = 'ollama';
  return nextEnv;
}

function buildConfig(value) {
  const provider = value.AI_ENABLED ? (value.AI_PROVIDER ?? 'ollama') : 'ollama';
  const model = provider === 'gemini' ? String(value.GEMINI_MODEL ?? '') : String(value.OLLAMA_MODEL ?? '');
  const config = {
    enabled: value.AI_ENABLED,
    provider,
    baseUrl: value.OLLAMA_BASE_URL,
    model,
    ollamaModel: String(value.OLLAMA_MODEL ?? ''),
    timeoutMs: value.OLLAMA_TIMEOUT_MS,
    numCtx: value.OLLAMA_NUM_CTX,
    keepAlive: value.OLLAMA_KEEP_ALIVE,
    maxConcurrency: value.AI_MAX_CONCURRENCY,
    autonomousEnabled: value.AI_AUTONOMOUS_ENABLED,
    minConfidence: value.AI_MIN_CONFIDENCE,
    maxRpm: value.AI_MAX_RPM,
    dailyBudget: value.AI_DAILY_BUDGET,
    autoSuggestEnabled: value.AI_AUTO_SUGGEST_ENABLED,
    gemini: {
      model: value.GEMINI_MODEL ?? '',
      timeoutMs: value.GEMINI_TIMEOUT_MS,
      maxOutputTokens: value.GEMINI_MAX_OUTPUT_TOKENS,
      hasKey: Boolean(value.GEMINI_API_KEY),
    },
  };
  return config;
}

/**
 * Read and validate the AI environment configuration.
 * @returns {{enabled:boolean,provider:'ollama'|'gemini',baseUrl:string,model:string,ollamaModel:string,timeoutMs:number,numCtx:number,keepAlive:string,maxConcurrency:number,autonomousEnabled:boolean,minConfidence:number,maxRpm:number,dailyBudget:number,autoSuggestEnabled:boolean,gemini:{model:string,timeoutMs:number,maxOutputTokens:number,hasKey:boolean}}}
 */
export function getAiConfig() {
  const env = applyTestOverrides({ ...process.env });
  const { error, value } = envSchema.validate(env, { abortEarly: false, convert: true });
  if (error) {
    const configError = new Error(`Configuration IA invalide : ${error.details.map(({ message }) => message).join('; ')}`);
    configError.code = 'AI_CONFIG_INVALID';
    throw configError;
  }
  return buildConfig(value);
}

export function describeConfigForLogs() {
  const config = getAiConfig();
  return {
    enabled: config.enabled,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    gemini: {
      model: config.gemini.model,
      timeoutMs: config.gemini.timeoutMs,
      maxOutputTokens: config.gemini.maxOutputTokens,
      hasKey: config.gemini.hasKey,
    },
    maxRpm: config.maxRpm,
    dailyBudget: config.dailyBudget,
    autoSuggestEnabled: config.autoSuggestEnabled,
  };
}

/**
 * Override selected config values in tests. Call the returned function to restore
 * the previous override state; passing null clears all overrides.
 */
export function overrideAiConfigForTests(partial) {
  if (partial === null) {
    testOverrides = {};
    return;
  }
  const previous = testOverrides;
  testOverrides = { ...testOverrides, ...partial };
  return () => {
    testOverrides = previous;
  };
}
