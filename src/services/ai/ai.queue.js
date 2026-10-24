import { getAiConfig } from './ai.config.js';

export function createAiQueue(processJob, { getConcurrency = () => getAiConfig().maxConcurrency } = {}) {
  const pending = [];
  let running = 0;

  function pump() {
    const concurrency = Math.max(1, Number(getConcurrency()) || 1);
    while (running < concurrency && pending.length > 0) {
      const job = pending.shift();
      running += 1;
      Promise.resolve()
        .then(() => processJob(job))
        .catch((error) => {
          console.error('Échec du worker IA', {
            suggestionId: job,
            code: error?.code ?? 'AI_INTERNAL_ERROR',
          });
        })
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  return {
    enqueue(job) {
      pending.push(job);
      pump();
    },
    getSnapshot() {
      return { pending: pending.length, running };
    },
  };
}

let queue;

export function getAiQueue(processJob) {
  if (!queue) {
    if (typeof processJob !== 'function') throw new Error('Le processeur de file IA doit être initialisé');
    queue = createAiQueue(processJob);
  }
  return queue;
}

export function getAiQueueSnapshot() {
  return queue?.getSnapshot() ?? { pending: 0, running: 0 };
}

export function resetAiQueueForTests() {
  queue = null;
}
