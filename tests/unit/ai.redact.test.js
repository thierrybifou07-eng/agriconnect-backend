import { describe, expect, it } from 'vitest';
import { redactClientBlocks } from '../../src/services/ai/ai.redact.js';

describe('redaction IA', () => {
  it('masque les données personnelles dans le bloc client sans toucher aux faits internes', () => {
    const input = '<message_client>Contact: test@example.com / +237 6 77 12 34 56 / https://example.com / 1 500 000 XAF</message_client>';
    const redacted = redactClientBlocks(input);

    expect(redacted).not.toContain('test@example.com');
    expect(redacted).not.toContain('+237 6 77 12 34 56');
    expect(redacted).not.toContain('https://example.com');
    expect(redacted).toContain('[e-mail]');
    expect(redacted).toContain('[téléphone]');
    expect(redacted).toContain('[lien]');
    expect(redacted).toContain('1 500 000 XAF');
  });
});
