import prisma from '../config/prisma.js';

export async function loadAgentForUser(userId) {
  return prisma.agent.findFirst({
    where: { userId, isActive: true },
    include: {
      capabilities: {
        include: { capability: { select: { code: true } } },
      },
    },
  });
}
