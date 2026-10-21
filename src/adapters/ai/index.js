import { env } from '../../config/env.js';
import { AiUnavailableError } from './errors.js';

// Provider-neutral AI slot. AI features are intentionally disabled in this
// phase; every repair, diagnostic and estimate workflow runs without AI.
//
// A provider (planned: OpenAI / ChatGPT) implements:
//   name, configured(), describe(),
//   generateStructured({ system, userContent, schema })
//     -> { output: object|null, refused: boolean, model: string, usage }
// Register it in PROVIDERS and set AI_PROVIDER to its name.

const PROVIDERS = {};

export { AiUnavailableError };

export const activeProvider = () => PROVIDERS[env.ai.provider] || null;

export const aiConfigured = () => Boolean(activeProvider()?.configured());

export const generateStructured = async (args) => {
  const provider = activeProvider();
  if (!provider || !provider.configured()) throw new AiUnavailableError('AI is not enabled for this deployment');
  return provider.generateStructured(args);
};

export const aiStatus = () => ({
  enabled: aiConfigured(),
  selected: env.ai.provider,
  availableProviders: Object.keys(PROVIDERS),
  note: 'AI assistance is not enabled in this release. All workflows operate without AI.'
});
