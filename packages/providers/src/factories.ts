import { createAlibaba } from '@ai-sdk/alibaba';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCerebras } from '@ai-sdk/cerebras';
import { createCohere } from '@ai-sdk/cohere';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createFireworks } from '@ai-sdk/fireworks';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createHuggingFace } from '@ai-sdk/huggingface';
import { createMiniMax } from '@ai-sdk/minimax';
import { createMistral } from '@ai-sdk/mistral';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createXai } from '@ai-sdk/xai';
import { createZai } from '@ai-sdk/zai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { ProviderEntry, ProviderKind } from './catalog-schema.js';

export interface FactoryInput {
  entry: ProviderEntry;
  model: string;
  apiKey?: string;
  baseURL?: string;
  env: NodeJS.ProcessEnv;
}
export type Factory = (i: FactoryInput) => LanguageModel;

const simple =
  (create: (o: { apiKey?: string; baseURL?: string }) => (id: string) => LanguageModel): Factory =>
  (i) =>
    create({ apiKey: i.apiKey, baseURL: i.baseURL })(i.model);

export const FACTORIES: Record<ProviderKind, Factory> = {
  'openai-compatible': (i) =>
    createOpenAICompatible({
      name: i.entry.id,
      baseURL: i.baseURL ?? '',
      apiKey: i.apiKey,
      supportsStructuredOutputs: true,
    })(i.model),
  openai: (i) => createOpenAI({ apiKey: i.apiKey, baseURL: i.baseURL }).chat(i.model),
  anthropic: simple(createAnthropic),
  google: simple(createGoogleGenerativeAI),
  xai: simple(createXai),
  azure: (i) => createAzure({ resourceName: i.env.AZURE_RESOURCE_NAME, apiKey: i.apiKey })(i.model),
  bedrock: (i) =>
    createAmazonBedrock({
      region: i.env.AWS_REGION,
      accessKeyId: i.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: i.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: i.env.AWS_SESSION_TOKEN,
      apiKey: i.env.AWS_BEARER_TOKEN_BEDROCK,
    })(i.model),
  vertex: (i) =>
    createVertex({ project: i.env.GOOGLE_VERTEX_PROJECT, location: i.env.GOOGLE_VERTEX_LOCATION })(
      i.model,
    ),
  'vertex-anthropic': (i) =>
    createVertexAnthropic({
      project: i.env.GOOGLE_VERTEX_PROJECT,
      location: i.env.GOOGLE_VERTEX_LOCATION,
    })(i.model),
  groq: simple(createGroq),
  mistral: simple(createMistral),
  cohere: simple(createCohere),
  deepseek: simple(createDeepSeek),
  cerebras: simple(createCerebras),
  deepinfra: simple(createDeepInfra),
  fireworks: simple(createFireworks),
  togetherai: simple(createTogetherAI),
  moonshotai: simple(createMoonshotAI),
  alibaba: simple(createAlibaba),
  minimax: simple(createMiniMax),
  huggingface: simple(createHuggingFace),
  perplexity: simple(createPerplexity),
  zai: simple(createZai),
  openrouter: (i) => createOpenRouter({ apiKey: i.apiKey, baseURL: i.baseURL }).chat(i.model),
};
