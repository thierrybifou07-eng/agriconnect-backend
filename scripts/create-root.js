import 'dotenv/config';
import readline from 'readline';
import bcrypt from 'bcrypt';
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
  const lastname = await ask('Nom : ');
  const firstname = await ask('Prénom : ');
  const phone = await ask('Téléphone : ');
  const email = await ask('E-mail : ');
  const password = await ask('Mot de passe (8 caractères min.) : ');

  if (!firstname || !lastname || !email || !phone || password.length < 8) {
    console.error('Nom, prénom, téléphone, email et mot de passe (8 caractères min.) sont requis.');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error('Un compte existe déjà avec cet email.');
    process.exit(1);
  }

  const rootRole = await prisma.role.findUnique({ where: { code: 'ROOT' } });
  const activeStatus = await prisma.userStatus.findUnique({ where: { code: 'ACTIVE' } });

  if (!rootRole || !activeStatus) {
    console.error('Tables de référence manquantes - exécute "npm run seed" avant ce script.');
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: { firstname, lastname, email, phone, password: hashedPassword, roleId: rootRole.id, userStatusId: activeStatus.id },
  });

  console.log(`Compte ROOT créé avec succès (id: ${user.id}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
