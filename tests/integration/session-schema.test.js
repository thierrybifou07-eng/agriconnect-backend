import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import prisma from '../../src/config/prisma.js';
import { PROJECT_ROOT } from '../setup/env.js';
import { createUser, createSession, createRefreshToken } from '../helpers/factory.js';

// La session est le modele qui rend le reste de la phase auth possible : elle
// dit de quel appareil vient une connexion, permet de n'en couper qu'une, et
// sert de point d'accroche a un jeton de rafraichissement.
//
// Ces tests verrouillent deux choses.
//
// D'un cote la forme : un jeton sans session doit etre impossible, au niveau de
// la base et pas seulement du client. Rendre sessionId nullable aurait permis
// a un jeton orphelin d'exister en silence.
//
// De l'autre cote la migration de donnees. "prisma migrate dev" regenere le SQL
// depuis le schema et perdrait silencieusement le traitement des 13 jetons
// existants : le fichier serait replaced par un simple ADD COLUMN, qui echouerait
// sur une table non vide, ou pire qui laisserait les jetons sans session.

const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'prisma', 'migrations');

function migrationSqlContaining(motif) {
  return readdirSync(MIGRATIONS_DIR)
    .map((dossier) => path.join(MIGRATIONS_DIR, dossier, 'migration.sql'))
    .filter((f) => existsSync(f))
    .filter((f) => readFileSync(f, 'utf8').includes(motif));
}

const modele = (nom) => Prisma.dmmf.datamodel.models.find((m) => m.name === nom);
const champ = (nomModele, nomChamp) => modele(nomModele).fields.find((f) => f.name === nomChamp);

describe('Modele Session', () => {
  it('expose les colonnes qui decrivent un appareil et une duree de vie', () => {
    const attendus = ['id', 'userId', 'userAgent', 'ip', 'lastActivityAt', 'expiresAt', 'revokedAt', 'createdAt'];
    const presents = modele('Session').fields.map((f) => f.name);

    for (const nom of attendus) expect(presents, `colonne Session.${nom} absente`).toContain(nom);
  });

  // Agent et IP sont absents plus souvent qu'ils ne sont presents : les rendre
  // obligatoires ferait echouer des creations de session pour une information
  // simplement inconnue.
  it('rend l\'agent et l\'IP facultatifs, mais l\'expiration obligatoire', () => {
    expect(champ('Session', 'userAgent').isRequired).toBe(false);
    expect(champ('Session', 'ip').isRequired).toBe(false);
    expect(champ('Session', 'expiresAt').isRequired).toBe(true);
  });

  // Une date plutot qu'un booleen : on peut ainsi distinguer une session
  // volontairement close d'une session simplement expiree, et purger par
  // anticipation.
  it('represente la fermeture par une date, pas par un booleen', () => {
    expect(champ('Session', 'revokedAt').isRequired).toBe(false);
    expect(modele('Session').fields.some((f) => f.name === 'revoked')).toBe(false);
  });
});

describe('Rattachement des jetons a une session', () => {
  it('rend sessionId obligatoire dans le schema', () => {
    expect(champ('RefreshToken', 'sessionId').isRequired).toBe(true);
  });

  it('expose la rotation et le successeur, absents avant cette phase', () => {
    // rotatedAt separe une rotation d'une revocation, ce que le seul booleen
    // "revoked" ne permettait pas. replacedById sert la fenetre de tolerance :
    // sans lui, un client dont deux appels paralleles sont en cours ne peut que
    // se faire refuser.
    expect(champ('RefreshToken', 'rotatedAt')).toBeDefined();
    expect(champ('RefreshToken', 'rotatedAt').isRequired).toBe(false);
    expect(champ('RefreshToken', 'replacedById')).toBeDefined();
    expect(champ('RefreshToken', 'replacedById').isRequired).toBe(false);
  });

  it('joint la session et ses jetons dans les deux sens', async () => {
    const utilisateur = await createUser();
    const session = await createSession(utilisateur, { userAgent: 'Jest/1.0', ip: '203.0.113.7' });
    const jeton = await createRefreshToken(utilisateur, session);

    const avecJetons = await prisma.session.findUnique({
      where: { id: session.id },
      include: { refreshTokens: true },
    });
    expect(avecJetons.userAgent).toBe('Jest/1.0');
    expect(avecJetons.ip).toBe('203.0.113.7');
    expect(avecJetons.refreshTokens.map((t) => t.id)).toEqual([jeton.id]);

    const sessionsDeLUtilisateur = await prisma.user.findUnique({
      where: { id: utilisateur.id },
      include: { sessions: true },
    });
    expect(sessionsDeLUtilisateur.sessions.map((s) => s.id)).toContain(session.id);
  });

  // Contrainte de la base, pas du client : c'est elle qui garantit qu'aucun
  // jeton ne peut exister sans session, meme en cas d'ecriture hors ORM.
  it('refuse un jeton sans session au niveau de la base', async () => {
    const utilisateur = await createUser();

    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO `RefreshToken` (`token`, `userId`, `expiresAt`) VALUES (?, ?, ?)',
        'jeton-orphelin',
        utilisateur.id,
        new Date(Date.now() + 60_000)
      )
    ).rejects.toThrow();
  });

  it('refuse de supprimer une session qui porte encore des jetons', async () => {
    const utilisateur = await createUser();
    const session = await createSession(utilisateur);
    await createRefreshToken(utilisateur, session);

    // ON DELETE RESTRICT : supprimer la session laisserait des jetons sans
    // porteur, que la rotation n'aurait plus de quoi mettre a jour.
    await expect(prisma.session.delete({ where: { id: session.id } })).rejects.toThrow();
  });
});

describe('Colonne emailVerified', () => {
  it('a remplace "verified", qui ne disait pas ce qui etait verifie', async () => {
    const colonnes = (await prisma.$queryRawUnsafe('SHOW COLUMNS FROM `User`')).map((c) => c.Field);

    expect(colonnes).toContain('emailVerified');
    expect(colonnes).not.toContain('verified');
  });

  it('vaut faux par defaut et reste un booleen', async () => {
    expect(champ('User', 'emailVerified').isRequired).toBe(true);
    const utilisateur = await createUser();
    expect(utilisateur.emailVerified).toBe(false);
  });
});

describe('Migration SQL : le traitement des donnees existing', () => {
  it('renomme la colonne au lieu de la recreer', () => {
    // DROP puis ADD perdrait la colonne sans erreur visible ; CHANGE COLUMN
    // conserve la donnee.
    const fichiers = migrationSqlContaining('emailVerified');
    expect(fichiers.length, 'aucune migration ne mentionne emailVerified').toBeGreaterThan(0);

    const sql = readFileSync(fichiers.at(-1), 'utf8');
    expect(sql).toMatch(/CHANGE\s+COLUMN\s+`?verified`?\s+`?emailVerified`?/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN\s+`?verified`?/i);
  });

  it('rattache les jetons existants a une session au lieu de les laisser orphelins', () => {
    const fichiers = migrationSqlContaining('sessionId');
    expect(fichiers.length, 'aucune migration ne mentionne sessionId').toBeGreaterThan(0);

    const sql = readFileSync(fichiers.at(-1), 'utf8');
    // Une session de transition par utilisateur, puis rattachement.
    expect(sql).toMatch(/INSERT\s+INTO\s+`?Session`?/i);
    expect(sql).toMatch(/UPDATE\s+`?RefreshToken`?[\s\S]*?JOIN\s+`?Session`?/i);
    // Sans ce passage, ADD COLUMN sessionId echouerait sur la table non vide.
    expect(sql).toMatch(/MODIFY\s+`?sessionId`?\s+INTEGER\s+NOT\s+NULL/i);
  });

  it('revoque les jetons anterieurs plutot que de les laisser actifs', () => {
    const fichiers = migrationSqlContaining('revoked` = true');
    expect(fichiers.length, 'aucune migration ne revoque les jetons anterieurs').toBeGreaterThan(0);
  });
});

describe('Index', () => {
  const indexDe = async (table) =>
    (await prisma.$queryRawUnsafe(`SHOW INDEX FROM \`${table}\``)).map((i) => i.Key_name);

  it('indexe les sessions par utilisateur et par expiration', async () => {
    const index = await indexDe('Session');
    expect(index).toContain('Session_userId_idx');
    // Sans cet index, la purge des sessions expirees balaierait toute la table.
    expect(index).toContain('Session_expiresAt_idx');
  });

  it('indexe les jetons par session', async () => {
    expect(await indexDe('RefreshToken')).toContain('RefreshToken_sessionId_idx');
  });
});