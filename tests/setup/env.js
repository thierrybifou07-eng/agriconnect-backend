import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Charge le .env de développement, puis bascule sur une base DEDIEE aux tests.
// Jamais la base de développement : les tests truncatent les tables entre
// chaque cas, ce qui détruirait les données de travail sans cela.
config({ path: path.join(ROOT, '.env') });

const DEV_URL = process.env.DATABASE_URL;
if (!DEV_URL) {
  throw new Error(
    'DATABASE_URL introuvable. Les tests lisent les identifiants MySQL dans le ' +
      '.env du projet et basculent automatiquement sur la base de test : aucune ' +
      'autre configuration n est nécessaire.'
  );
}

// Remplace le dernier segment du chemin par le nom de la base de test, sans
// utiliser new URL() : le mot de passe peut contenir des caracteres reserves.
const TEST_DB_NAME = process.env.TEST_DB_NAME || 'agriconnect_test';
const testUrl = DEV_URL.replace(/\/[^/?#]*([?#].*)?$/, `/${TEST_DB_NAME}$1`);

process.env.DATABASE_URL = testUrl;
process.env.TEST_DB_NAME = TEST_DB_NAME;
process.env.NODE_ENV = 'test';

// Secret fixe : evite de dependre du .env et rend les jetons reproductibles.
process.env.JWT_SECRET = 'test-secret-jwt-ne-pas-utiliser-en-production';
process.env.JWT_EXPIRES_IN = '1h';
process.env.REFRESH_TOKEN_TTL_DAYS = '30';

// Aucun SMTP en test. On ne se contente pas de vider SMTP_HOST : le transport
// actuel pointe en dur sur 127.0.0.1:1025 et tente donc une connexion a chaque
// inscription, ce qui echoue et fait remonter l'erreur au middleware d'erreur.
// Le mail est neutralise ici, proprement, plutot que dans chaque test.
process.env.SMTP_DISABLED = '1';
process.env.EMAIL_SENDER = 'test@agriconnect.local';

export const TEST_DATABASE_URL = testUrl;
export const PROJECT_ROOT = ROOT;
