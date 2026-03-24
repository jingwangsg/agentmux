import { describe, expect, it } from 'vitest';
import { getConversationConfigCandidates } from './config.js';

describe('runtime config model labels', () => {
  it('preserves provider-qualified codex model labels', () => {
    const options = getConversationConfigCandidates('codex', { model: 'openai/openai/gpt-5.4' });
    const candidate = options.candidates.model.find((item) => item.value === 'openai/openai/gpt-5.4');

    expect(candidate).toMatchObject({
      value: 'openai/openai/gpt-5.4',
      label: 'openai/openai/gpt-5.4',
    });
  });
});
