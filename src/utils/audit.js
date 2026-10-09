// Journal d'audit : une ligne par action sensible (plan v2, P1.4).
//
// `db` est le client Prisma de la transaction courante (ou prisma lui-meme
// hors transaction) : l'audit fait partie de la meme transaction que l'action
// qu'il trace. Un echec de l'audit annule donc l'action, et inversement :
// l'audit ne ment jamais par omission silencieuse.
//
// Ce helper ne masque JAMAIS ses erreurs : une ecriture qui echoue doit
// echouer l'action, pas etre avalee en silence.
//
// Convention d'action : MAJUSCULES_AVEC_UNDERSCORES (ex. LOT_VALIDATED).
export async function recordAudit(db, { actorUser, actorAgent, action, entityType, entityId, metadata }) {
  await db.auditLog.create({
    data: {
      actorUserId: actorUser?.id ?? null,
      actorAgentId: actorAgent?.id ?? null,
      action,
      entityType,
      entityId,
      metadata: metadata ?? undefined,
    },
  });
}
