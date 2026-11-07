/**
 * "Add AI" presets (lib/ai/presets.ts): every preset must be a provider the app can actually
 * build and classify the way its card says — cloud ones public HTTPS, local ones on this computer
 * — and its base URL must survive openAiBase (Gemini's and OpenRouter's are not at /v1).
 */
import { describe, expect, it } from 'vitest';
import { AI_PRESETS, presetOf } from './presets';
import { openAiBase } from './providers';
import { classifyEndpoint } from './tailnet';

describe('AI presets', () => {
  it('cloud presets are public HTTPS endpoints that need a key; local ones are on this computer', () => {
    for (const p of AI_PRESETS) {
      if (p.kind === 'anthropic') continue;
      if (!p.baseUrl) continue; // "Other" is typed by the person
      const ep = classifyEndpoint(p.baseUrl);
      if (p.where === 'cloud') {
        expect(ep.hostClass, p.id).toBe('public');
        expect(ep.protocol, p.id).toBe('https');
        expect(p.needsKey, p.id).toBe(true);
        expect(p.getUrl, p.id).toMatch(/^https:\/\//);
      } else {
        expect(ep.hostClass, p.id).toBe('loopback');
      }
    }
  });

  it('OpenAI-compatible base URLs keep their own path', () => {
    for (const p of AI_PRESETS) {
      if (p.kind !== 'openai-compatible' || !p.baseUrl) continue;
      expect(openAiBase(p.baseUrl), p.id).toBe(p.baseUrl.replace(/\/+$/, ''));
    }
  });

  it('a saved provider is traced back to its preset by kind and base URL', () => {
    expect(presetOf({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/' })?.id).toBe('openai');
    expect(presetOf({ kind: 'anthropic', baseUrl: null })?.id).toBe('anthropic');
    expect(presetOf({ kind: 'openai-compatible', baseUrl: 'http://gpu-box:8000/v1' })).toBeUndefined();
  });
});
