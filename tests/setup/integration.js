import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { TEST_DATABASE_URL, PROJECT_ROOT, TEST_DB_NAME } from './env.js';

const SYSTEM_DB_URL = TEST_DATABASE_URL.replace(/\/[^/?#]*([?#].*)?$/, '/mysql$1');

// Appelle le point d'entree JS du CLI Prisma plutot que le binaire de
// node_modules/.bin : ce dernier est un script shell sous Windows et
// "npx" n'est pas resolu comme executable sur cette plateforme.
const PRISMA_CLI = path.join(PROJECT_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

function runPrisma(args) {
  execFileSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

// Provisionne la base de test : creation si absente, schema a jour, tables de
// reference peuplees. Execute une seule fois avant toute la suite.
export async function setup() {
  // 1. Creer la base. On passe par la base systeme "mysql" car Prisma ne peut
  //    pas se connecter a une base qui n'existe pas encore.
  const { default: pkg } = await import('@prisma/client');
  const { PrismaClient } = pkg;
  const admin = new PrismaClient({ datasources: { db: { url: SYSTEM_DB_URL } } });
  try {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE IF NOT EXISTS \`${TEST_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.$disconnect();
  }

  // 2. Appliquer les migrations. Volontairement "deploy" et non "db push" :
  //    cela verifie au passage que le SQL de migration est encore valide.
  runPrisma(['migrate', 'deploy']);

  // 3. Peupler les tables de reference (roles, statuts, categories, types).
  execFileSync('node', [path.join('prisma', 'seed.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}
