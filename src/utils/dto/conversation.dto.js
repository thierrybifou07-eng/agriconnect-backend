// DTO de messagerie (plan v2, P3.1).
//
// Côté client, la règle d'or est l'anonymat : le client parle à « l'équipe
// AgriConnect », jamais à un agent identifié, et ne voit jamais un autre
// utilisateur. Le DTO client ne contient donc aucun identifiant d'agent ni
// d'utilisateur tiers (pas de assignedAgentId, senderAgentId, senderUserId,
// customerId) : la provenance d'un message est rendue par senderLabel.

// Conversation côté client : le suivi de SA conversation, sans identité.
export function conversationToClientDto(conversation) {
  return {
    id: conversation.id,
    type: conversation.type,
    status: conversation.status,
    subject: conversation.subject ?? null,
    listingId: conversation.listingId ?? null,
    lotId: conversation.lotId ?? null,
    escalatedAt: conversation.escalatedAt,
    escalationReason: conversation.escalationReason ?? null,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
  };
}

// Message côté client : « Vous » pour l'auteur, « Équipe AgriConnect » pour
// le staff. Les notes internes (isInternal) ne sont jamais renvoyées : le
// filtre est fait par la requête, pas ici.
export function messageToClientDto(message) {
  return {
    id: message.id,
    content: message.content,
    senderLabel: message.senderType === 'CUSTOMER' ? 'Vous' : 'Équipe AgriConnect',
    createdAt: message.createdAt,
  };
}

// Conversation côté staff : l'équipe a besoin de savoir QUI écrit (agent ou
// utilisateur) et QUI est le client. Ces identifiants ne sortent jamais du
// périmètre staff (le catalogue acheteur, lui, est anonymisé : P2.6).
export function conversationToStaffDto(conversation) {
  return {
    id: conversation.id,
    type: conversation.type,
    status: conversation.status,
    subject: conversation.subject ?? null,
    listingId: conversation.listingId ?? null,
    lotId: conversation.lotId ?? null,
    customer: conversation.customer
      ? {
          id: conversation.customer.id,
          firstname: conversation.customer.firstname,
          lastname: conversation.customer.lastname,
        }
      : null,
    assignedAgentId: conversation.assignedAgentId ?? null,
    assignedAgent: conversation.assignedAgent
      ? { id: conversation.assignedAgent.id, displayName: conversation.assignedAgent.displayName }
      : null,
    escalatedAt: conversation.escalatedAt,
    escalationReason: conversation.escalationReason ?? null,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
  };
}

// Message côté staff : l'identité complète de l'auteur, y compris les notes
// internes (visibles par l'équipe seulement).
export function messageToStaffDto(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderType: message.senderType,
    senderUserId: message.senderUserId ?? null,
    senderAgentId: message.senderAgentId ?? null,
    content: message.content,
    isInternal: message.isInternal,
    createdAt: message.createdAt,
  };
}
