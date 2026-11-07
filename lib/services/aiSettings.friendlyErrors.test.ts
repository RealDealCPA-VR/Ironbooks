/**
 * "Test connection" failures in plain words (lib/services/aiSettings.ts friendlyTestError): a key
 * that was not accepted, a local server that is not running, a wrong URL — with the raw detail
 * kept after the explanation. Network-policy refusals already explain themselves.
 */
import { describe, expect, it } from 'vitest';
import { friendlyTestError } from './aiSettings';

describe('friendly test-connection errors', () => {
  it('a rejected API key says so', () => {
    const msg = friendlyTestError('HTTP 401 from api.openai.com: {"error":{"message":"Incorrect API key"}}', 'openai-compatible', 'https://api.openai.com/v1');
    expect(msg).toMatch(/API key was not accepted/);
    expect(msg).toMatch(/HTTP 401/);
    expect(friendlyTestError('Anthropic HTTP 401: invalid x-api-key', 'anthropic', null)).toMatch(/API key was not accepted/);
  });

  it('a local server that is not running names the program to start', () => {
    expect(friendlyTestError('Could not reach localhost:11434: fetch failed', 'ollama', 'http://localhost:11434')).toMatch(/Start Ollama/);
    expect(friendlyTestError('Could not reach localhost:1234: ECONNREFUSED', 'openai-compatible', 'http://localhost:1234/v1')).toMatch(/LM Studio/);
  });

  it('a wrong address and a timeout are explained; policy refusals pass through', () => {
    expect(friendlyTestError('HTTP 404 from api.example.com', 'openai-compatible', 'https://api.example.com/wrong')).toMatch(/ends in \/v1/);
    expect(friendlyTestError('Request to api.openai.com timed out.', 'openai-compatible', 'https://api.openai.com/v1')).toMatch(/No answer in time/);
    const policy = 'Blocked by network policy: AI assistance would contact api.openai.com on the internet';
    expect(friendlyTestError(policy, 'openai-compatible', 'https://api.openai.com/v1')).toBe(policy);
  });
});
