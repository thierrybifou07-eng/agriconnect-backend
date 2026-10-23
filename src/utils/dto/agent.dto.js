export function agentToClientDto(agent) {
  if (!agent) return null;

  return {
    id: agent.id,
    displayName: agent.displayName,
    kind: agent.kind,
    autonomy: agent.autonomy,
    capabilities: agent.capabilities
      .map(({ capability }) => capability.code)
      .sort(),
  };
}
