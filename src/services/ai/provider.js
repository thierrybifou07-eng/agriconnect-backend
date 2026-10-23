import { AiError } from './ai.error.js';
import { createOllamaProvider } from './ollama.provider.js';

/**
 * @typedef {object} AiProvider
 * @property {() => Promise<{reachable:boolean,installedModels:string[]}>} ping
 * @property {() => Promise<{installed:boolean,capabilities:string[],details:object|null}>} describeModel
 * @property {(input:{system:string,user:string,schema:object,options?:object}) => Promise<{data:object,latencyMs:number,promptTokens:number|null,completionTokens:number|null}>} generateStructured
 */

/** @param {{aiProvider?:string}|null} [agent] */
export function getProvider(agent = null) {
  const providerName = agent?.aiProvider ?? 'ollama';
  if (providerName === 'ollama') return createOllamaProvider();
  throw new AiError('AI_PROVIDER_UNSUPPORTED', `Fournisseur IA non pris en charge : ${providerName}`);
}
