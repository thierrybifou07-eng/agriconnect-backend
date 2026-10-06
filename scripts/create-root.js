import 'dotenv/config';
import readline from 'readline';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Script à exécuter manuellement sur le serveur, JAMAIS via l'API : npm run create:root
async function main() {
  console.log("=== Création d'un compte ROOT (accès total, à usage exceptionnel) ===");
  const fullName = await ask('Nom complet : ');
  const phone = await ask('Téléphone : ');
  const email = await ask('E-mail : ');
  const password = await ask('Mot de passe (8 caractères min.) : ');

  if (!fullName || !phone || !email || password.length < 8) {
    console.error('Nom complet, téléphone, email et mot de passe (8 caractères min.) sont requis.');
    process.exit(1);
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ phone }, { email }] },
  });

  if (existing) {
    console.error('Un compte existe déjà avec ce téléphone ou cet email.');
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      fullName,
      phone,
      email,
      passwordHash: hashedPassword,
      role: 'ROOT',
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      referralCode: randomUUID(),
    },
  });

  console.log(`Compte ROOT créé avec succès (id: ${user.id}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
