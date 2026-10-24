import { AiError } from './ai.error.js';
import { createOllamaProvider } from './ollama.provider.js';
import { createGeminiProvider } from './gemini.provider.js';
import { getAiConfig } from './ai.config.js';

/**
 * @typedef {object} AiProvider
 * @property {() => Promise<{reachable:boolean,installedModels:string[],authenticated?:boolean|null}>} ping
 * @property {() => Promise<{installed:boolean,capabilities:string[],details:object|null}>} describeModel
 * @property {(input:{system:string,user:string,schema:object,options?:object}) => Promise<{data:object,latencyMs:number,promptTokens:number|null,completionTokens:number|null}>} generateStructured
 */

export function resolveProviderName(agent = null) {
  if (agent?.aiProvider) return agent.aiProvider;
  return getAiConfig().provider;
}

/** @param {{aiProvider?:string}|null} [agent] */
export function getProvider(agent = null) {
  const providerName = resolveProviderName(agent);
  if (providerName === 'ollama') return createOllamaProvider();
  if (providerName === 'gemini') return createGeminiProvider();
  throw new AiError('AI_PROVIDER_UNSUPPORTED', `Fournisseur IA non pris en charge : ${providerName}`);
}
