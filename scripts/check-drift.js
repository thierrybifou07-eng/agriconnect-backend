// Contrôle de dérive entre les migrations appliquées et le schéma Prisma.
// Utilise une base SHADOW dédiée (vide) que Prisma crée et détruit pour
// l'occasion. Codes de sortie, sans ambiguïté :
//   0 = aucun écart, 1 = écart détecté, 2 = configuration manquante,
//   3 = erreur d'exécution (Prisma renvoie 2 pour un écart et 1 pour une
//   erreur : ces codes sont traduits ci-dessous pour ne pas entrer en
//   collision avec les nôtres).
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
  process.exit(3);
}

// --exit-code fait sortir Prisma avec 2 en cas d'écart et 1 en cas d'erreur :
// ces codes entreraient en collision avec les nôtres, on les traduit donc
// explicitement pour que le script ait toujours le même contrat.
if (result.status === 0) {
  process.exit(0); // aucun écart
}
if (result.status === 2) {
  process.exit(1); // écart détecté
}
process.exit(3); // tout autre code : erreur d'exécution de Prisma
