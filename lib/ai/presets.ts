/**
 * "Add AI" presets — the AIs a person can plug in without knowing a server URL or model id by
 * heart (app/ai-settings/page.tsx). Each preset is just a starting draft of a provider row: the
 * same three provider kinds underneath (lib/ai/providers.ts), so nothing here changes how calls
 * are made, redacted or policed. Shared with the docs (README "Bring your own AI").
 *
 * Cloud presets use each service's OpenAI-compatible endpoint where it has one; Anthropic uses
 * its own SDK. Default models are known-good names at the time of writing; "Test connection"
 * lists the live models, so a stale default is one click to replace.
 */
import type { ProviderKind } from './types';

export interface AiPreset {
  id: string;
  /** What the person sees: the product name they already know. */
  name: string;
  /** One line under the name. */
  blurb: string;
  kind: ProviderKind;
  /** Where the model runs, in plain words. */
  where: 'this computer' | 'cloud';
  baseUrl: string;
  defaultModel: string;
  /** Needs an API key from the service (cloud); local servers usually don't. */
  needsKey: boolean;
  /** Where to get a key (cloud) or the program (local). */
  getUrl: string | null;
  getLabel: string | null;
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    blurb: 'Free, runs on this computer. Nothing leaves your PC.',
    kind: 'ollama',
    where: 'this computer',
    baseUrl: 'http://localhost:11434',
    defaultModel: '',
    needsKey: false,
    getUrl: 'https://ollama.com/download',
    getLabel: 'Get Ollama',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    blurb: 'Free, runs on this computer. Turn on its local server first.',
    kind: 'openai-compatible',
    where: 'this computer',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    needsKey: false,
    getUrl: 'https://lmstudio.ai',
    getLabel: 'Get LM Studio',
  },
  {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    blurb: 'GPT models from your OpenAI account.',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
    needsKey: true,
    getUrl: 'https://platform.openai.com/api-keys',
    getLabel: 'Get an OpenAI API key',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    blurb: 'Claude models from your Anthropic account.',
    kind: 'anthropic',
    where: 'cloud',
    baseUrl: '',
    defaultModel: 'claude-sonnet-5-5',
    needsKey: true,
    getUrl: 'https://console.anthropic.com/settings/keys',
    getLabel: 'Get an Anthropic API key',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    blurb: 'Gemini models with a Google AI Studio key.',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    getUrl: 'https://aistudio.google.com/apikey',
    getLabel: 'Get a Gemini API key',
  },
  {
    id: 'groq',
    name: 'Groq',
    blurb: 'Very fast open models (Llama, etc.).',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true,
    getUrl: 'https://console.groq.com/keys',
    getLabel: 'Get a Groq API key',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    blurb: 'One key for hundreds of models from many makers.',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5',
    needsKey: true,
    getUrl: 'https://openrouter.ai/keys',
    getLabel: 'Get an OpenRouter API key',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    blurb: 'Mistral models from your Mistral account.',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    needsKey: true,
    getUrl: 'https://console.mistral.ai/api-keys',
    getLabel: 'Get a Mistral API key',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    blurb: 'Grok models from your xAI account.',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    needsKey: true,
    getUrl: 'https://console.x.ai',
    getLabel: 'Get an xAI API key',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    blurb: 'DeepSeek models from your DeepSeek account.',
    kind: 'openai-compatible',
    where: 'cloud',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    needsKey: true,
    getUrl: 'https://platform.deepseek.com/api_keys',
    getLabel: 'Get a DeepSeek API key',
  },
  {
    id: 'custom',
    name: 'Other OpenAI-compatible server',
    blurb: 'vLLM, llama.cpp, a GPU box on your network, or any API that speaks the OpenAI format.',
    kind: 'openai-compatible',
    where: 'this computer',
    baseUrl: '',
    defaultModel: '',
    needsKey: false,
    getUrl: null,
    getLabel: null,
  },
];

export function presetById(id: string): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.id === id);
}

function normUrl(u: string | null | undefined): string {
  return (u ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** The preset a saved or drafted provider came from (by kind + base URL), if any. */
export function presetOf(p: { kind: ProviderKind; baseUrl?: string | null }): AiPreset | undefined {
  const url = normUrl(p.baseUrl);
  if (p.kind === 'anthropic') return url === '' || url === 'https://api.anthropic.com' ? presetById('anthropic') : undefined;
  return AI_PRESETS.find((x) => x.kind === p.kind && x.baseUrl && normUrl(x.baseUrl) === url);
}
