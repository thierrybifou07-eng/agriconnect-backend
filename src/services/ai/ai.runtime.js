let lastLatencyMs = null;

export function recordAiLatency(latencyMs) {
  lastLatencyMs = latencyMs;
}

export function getLastAiLatencyMs() {
  return lastLatencyMs;
}
