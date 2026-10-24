import { describe, expect, it } from 'vitest';
import { createThrottle } from '../../src/services/ai/ai.throttle.js';

describe('throttle IA', () => {
  it('bloque quand la fenêtre ou le budget est dépassé', async () => {
    let now = 1_700_000_000_000;
    const throttle = createThrottle({ maxRpm: 2, dailyBudget: 2, now: () => now });

    expect(throttle.canAcquire()).toMatchObject({ ok: true });
    await throttle.acquire();
    await throttle.acquire();
    expect(throttle.getSnapshot().usedToday).toBe(2);
    expect(throttle.canAcquire()).toMatchObject({ ok: false, reason: 'window' });
  });
});
