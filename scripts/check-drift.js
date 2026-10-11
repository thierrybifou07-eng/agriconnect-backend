// Contrôle de dérive entre les migrations appliquées et le schéma Prisma.
// Utilise une base SHADOW dédiée (vide) que Prisma crée et détruit pour
// l'occasion. Renvoie le code de sortie de `prisma migrate diff` :
//   0 = pas de dérive, 1 = dérive détectée, 2 = configuration manquante.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const shadowUrl = process.env.SHADOW_DATABASE_URL;
if (!shadowUrl) {
  console.error(
    "SHADOW_DATABASE_URL n'est pas défini.\n" +
      'Ajoutez-le à votre fichier .env en copiant la ligne de .env.example :\n' +
      '  SHADOW_DATABASE_URL="mysql://user:password@localhost:3306/agriconnect_shadow"\n' +
      'La base doit être VIDE et l\'utilisateur MySQL doit avoir les droits CREATE et DROP.'
  );
  process.exit(2);
}

// On appelle le point d'entrée JS du CLI Prisma plutôt que le binaire de
// node_modules/.bin : ce dernier est un script shell sous Windows et "npx"
// n'est pas résolu comme exécutable sur cette plateforme.
const prismaCli = path.join(PROJECT_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    'migrate', 'diff',
    '--from-migrations', path.join('prisma', 'migrations'),
    '--to-schema-datamodel', path.join('prisma', 'schema.prisma'),
    '--shadow-database-url', shadowUrl,
    '--exit-code',
  ],
  {
    cwd: PROJECT_ROOT,
    env: { ...process.env, SHADOW_DATABASE_URL: shadowUrl },
    stdio: 'inherit',
    encoding: 'utf8',
  }
);

if (result.error) {
  console.error('Échec de l\'exécution de prisma migrate diff :', result.error.message);
  process.exit(2);
}

process.exit(result.status ?? 2);
