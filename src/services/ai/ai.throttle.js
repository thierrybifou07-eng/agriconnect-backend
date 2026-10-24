import { AiError } from './ai.error.js';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_WAIT_MS = 20_000;

function getPacificDateParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return values;
}

function getPacificDayKey(date) {
  const { year, month, day } = getPacificDateParts(date);
  return `${year}-${month}-${day}`;
}

function nextPacificMidnight(date) {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

export function createThrottle({
  maxRpm = 8,
  dailyBudget = 200,
  windowMs = DEFAULT_WINDOW_MS,
  waitMs = DEFAULT_WAIT_MS,
  now = () => Date.now(),
} = {}) {
  const recent = [];
  let usedToday = 0;
  let todayKey = getPacificDayKey(new Date(now()));

  function ensureDay() {
    const currentKey = getPacificDayKey(new Date(now()));
    if (currentKey !== todayKey) {
      todayKey = currentKey;
      usedToday = 0;
    }
  }

  function getSnapshot() {
    ensureDay();
    return {
      maxRpm,
      dailyBudget,
      usedToday,
      resetsAt: nextPacificMidnight(new Date(now())),
    };
  }

  function getThrottleSnapshot() {
    return getSnapshot();
  }

  function canAcquire() {
    ensureDay();
    const cutoff = now() - windowMs;
    while (recent.length && recent[0] <= cutoff) recent.shift();
    if (recent.length >= maxRpm) return { ok: false, reason: 'window' };
    if (usedToday >= dailyBudget) return { ok: false, reason: 'budget' };
    return { ok: true };
  }

  async function acquire() {
    const deadline = now() + waitMs;
    while (true) {
      const check = canAcquire();
      if (check.ok) {
        recent.push(now());
        usedToday += 1;
        return;
      }
      if (now() >= deadline) {
        const error = new AiError('AI_RATE_LIMITED', 'Quota IA dépassé');
        error.retryAfterMs = Math.max(0, deadline - now());
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { acquire, canAcquire, getSnapshot };
}

export const getThrottle = (() => {
  let instance = null;
  return (config = null) => {
    if (!instance) {
      instance = createThrottle({
        maxRpm: Number(config?.maxRpm ?? process.env.AI_MAX_RPM ?? 8),
        dailyBudget: Number(config?.dailyBudget ?? process.env.AI_DAILY_BUDGET ?? 200),
      });
    }
    return instance;
  };
})();
