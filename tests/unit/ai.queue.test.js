import { describe, expect, it } from 'vitest';
import { createAiQueue } from '../../src/services/ai/ai.queue.js';

describe('file de suggestions IA', () => {
  it('traite les jobs FIFO et respecte la concurrence configurée', async () => {
    const starts = [];
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const queue = createAiQueue(async (job) => {
      starts.push(job);
      if (job === 1) await first;
    }, { getConcurrency: () => 1 });

    queue.enqueue(1);
    queue.enqueue(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual([1]);
    expect(queue.getSnapshot()).toMatchObject({ pending: 1, running: 1 });

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual([1, 2]);
  });
});
