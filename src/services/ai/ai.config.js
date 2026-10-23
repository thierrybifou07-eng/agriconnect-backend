import 'dotenv/config';
import Joi from 'joi';

const envSchema = Joi.object({
  AI_ENABLED: Joi.boolean().default(false),
  OLLAMA_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: Joi.string().trim().when('AI_ENABLED', {
    is: true,
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  OLLAMA_TIMEOUT_MS: Joi.number().integer().min(1).default(120000),
  OLLAMA_NUM_CTX: Joi.number().integer().min(1).default(4096),
  OLLAMA_KEEP_ALIVE: Joi.string().trim().min(1).default('10m'),
  AI_MAX_CONCURRENCY: Joi.number().integer().min(1).default(1),
  AI_AUTONOMOUS_ENABLED: Joi.boolean().default(false),
  AI_MIN_CONFIDENCE: Joi.number().min(0).max(1).default(0.8),
}).unknown(true);

const envToConfig = {
  AI_ENABLED: 'enabled',
  OLLAMA_BASE_URL: 'baseUrl',
  OLLAMA_MODEL: 'model',
  OLLAMA_TIMEOUT_MS: 'timeoutMs',
  OLLAMA_NUM_CTX: 'numCtx',
  OLLAMA_KEEP_ALIVE: 'keepAlive',
  AI_MAX_CONCURRENCY: 'maxConcurrency',
  AI_AUTONOMOUS_ENABLED: 'autonomousEnabled',
  AI_MIN_CONFIDENCE: 'minConfidence',
};

let testOverrides = {};

/**
 * Read and validate the AI environment configuration.
 * @returns {{enabled:boolean,baseUrl:string,model:string,timeoutMs:number,numCtx:number,keepAlive:string,maxConcurrency:number,autonomousEnabled:boolean,minConfidence:number}}
 */
export function getAiConfig() {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(testOverrides)) {
    const envKey = Object.entries(envToConfig).find(([, configKey]) => configKey === key)?.[0];
    if (envKey) env[envKey] = value;
  }

  const { error, value } = envSchema.validate(env, { abortEarly: false, convert: true });
  if (error) {
    const configError = new Error(`Configuration IA invalide : ${error.details.map(({ message }) => message).join('; ')}`);
    configError.code = 'AI_CONFIG_INVALID';
    throw configError;
  }

  return Object.fromEntries(
    Object.entries(envToConfig).map(([envKey, configKey]) => [configKey, value[envKey]]),
  );
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
