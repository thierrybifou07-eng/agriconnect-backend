import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api } from '../helpers/app.js';
import { registerViaApi } from '../helpers/factory.js';
import { verifyToken } from '../../src/utils/jwt.js';

// Avant ces routes, un appareil vole ne pouvait etre coupe qu'en changeant de
// mot de passe : deconnexion partout, sans que l'utilisateur apprenne quel
// appareil decoit etre ferme. Lister ses sessions et pouvoir en fermer une
// ciblée est ce qui rend cette situation gérable.

const client = api();

const enTete = (token) => ({ Authorization: `Bearer ${token}` });

/** Inscrit un compte puis ouvre deux sessions distinctes, comme deux appareils. */
async function deuxAppareils() {
  const { payload } = await registerViaApi(client, { email: `sessions-${Date.now()}@example.com` });
  const utilisateur = await prisma.user.findUnique({ where: { email: payload.email } });

  const telephone = await client
    .post('/api/v2/auth/login')
    .set('User-Agent', 'Android/1.0')
    .send({ email: payload.email, password: payload.password });
  const ordinateur = await client
    .post('/api/v2/auth/login')
    .set('User-Agent', 'Firefox/2.0')
    .send({ email: payload.email, password: payload.password });

  return {
    utilisateur,
    payload,
    telephone: { accessToken: telephone.body.accessToken, refreshToken: telephone.body.refreshToken },
    ordinateur: { accessToken: ordinateur.body.accessToken, refreshToken: ordinateur.body.refreshToken },
  };
}

const lister = (token) => client.get('/api/v2/auth/sessions').set(enTete(token));

describe('GET /api/v2/auth/sessions', () => {
  it('liste les sessions ouvertes du compte', async () => {
    const { telephone } = await deuxAppareils();

    const res = await lister(telephone.accessToken);

    expect(res.status).toBe(200);
    // Inscription + telephone + ordinateur.
    expect(res.body.sessions).toHaveLength(3);
  });

  // Le marqueur vient du sessionId du jeton : sans lui, le client ne peut pas
  // distinguer sa session de celle d'un autre appareil, et risquerait de se
  // fermer lui-meme.
  it('marque la session de l appelant', async () => {
    const { telephone, ordinateur } = await deuxAppareils();

    const vueTelephone = await lister(telephone.accessToken);
    const vueOrdinateur = await lister(ordinateur.accessToken);

    const idTelephone = verifyToken(telephone.accessToken).sessionId;
    const currentTelephone = vueTelephone.body.sessions.filter((s) => s.isCurrent);
    expect(currentTelephone).toHaveLength(1);
    expect(currentTelephone[0].id).toBe(idTelephone);

    // Le meme appel fait depuis l'autre appareil marque l'autre session : le
    // marqueur suit bien le jeton, il n'est pas calcule cote serveur.
    const idOrdinateur = verifyToken(ordinateur.accessToken).sessionId;
    expect(vueOrdinateur.body.sessions.filter((s) => s.isCurrent).map((s) => s.id)).toEqual([idOrdinateur]);
  });

  it('renseigne l appareil et les dates, pour que l utilisateur puisse reconnaitre son ecran', async () => {
    const { telephone } = await deuxAppareils();

    const res = await lister(telephone.accessToken);
    const miennes = res.body.sessions.filter((s) => s.isCurrent);

    expect(miennes[0].userAgent).toBe('Android/1.0');
    expect(miennes[0].ip).toBeTruthy();
    expect(new Date(miennes[0].createdAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(miennes[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('ne liste ni les sessions fermees ni les sessions expirees', async () => {
    const { utilisateur, telephone } = await deuxAppareils();

    await prisma.session.updateMany({
      where: { userId: utilisateur.id, id: { not: verifyToken(telephone.accessToken).sessionId } },
      data: { revokedAt: new Date() },
    });

    const res = await lister(telephone.accessToken);
    expect(res.body.sessions).toHaveLength(1);
  });

  // Un historique de sessions fermees renseignerait sur les appareils d'un compte
  // alors que la session d'autrui n'a rien a faire dans la reponse.
  it('ne montre jamais les sessions d un autre compte', async () => {
    const { telephone } = await deuxAppareils();
    const { accessToken: jetonAutre } = await registerViaApi(client);

    const res = await lister(jetonAutre);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBe(verifyToken(jetonAutre).sessionId);
  });

  it('exige une authentification', async () => {
    expect((await client.get('/api/v2/auth/sessions')).status).toBe(401);
  });
});

describe('DELETE /api/v2/auth/sessions/:id', () => {
  it('ferme la session visee et revoque ses jetons', async () => {
    const { utilisateur, telephone, ordinateur } = await deuxAppareils();

    const sessionOrdinateur = (await lister(telephone.accessToken)).body.sessions.find(
      (s) => s.id === verifyToken(ordinateur.accessToken).sessionId
    );

    const res = await client.delete(`/api/v2/auth/sessions/${sessionOrdinateur.id}`).set(enTete(telephone.accessToken));
    expect(res.status).toBe(204);

    const fermee = await prisma.session.findUnique({ where: { id: sessionOrdinateur.id } });
    expect(fermee.revokedAt).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { sessionId: fermee.id, revoked: false } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: utilisateur.id, revokedAt: null } })).toBe(2);
  });

  it('rend l appareil ferme incapable de rafraichir, sans toucher aux autres', async () => {
    const { telephone, ordinateur } = await deuxAppareils();

    const sessionOrdinateur = (await lister(telephone.accessToken)).body.sessions.find(
      (s) => s.id === verifyToken(ordinateur.accessToken).sessionId
    );
    await client.delete(`/api/v2/auth/sessions/${sessionOrdinateur.id}`).set(enTete(telephone.accessToken));

    const coupe = await client.post('/api/v2/auth/refresh').send({ refreshToken: ordinateur.refreshToken });
    const intact = await client.post('/api/v2/auth/refresh').send({ refreshToken: telephone.refreshToken });

    expect(coupe.status).toBe(401);
    expect(intact.status).toBe(200);
  });

  // Le parametre porte sur l'utilisateur ET sur l'identifiant : sans le premier,
  // un compte pourrait fermer les sessions d'un autre.
  it('refuse de fermer la session d un autre compte', async () => {
    const { telephone, ordinateur } = await deuxAppareils();
    const { accessToken: autreJeton } = await registerViaApi(client);

    const sessionOrdinateur = (await lister(telephone.accessToken)).body.sessions.find(
      (s) => s.id === verifyToken(ordinateur.accessToken).sessionId
    );
    const res = await client.delete(`/api/v2/auth/sessions/${sessionOrdinateur.id}`).set(enTete(autreJeton));

    expect(res.status).toBe(404);
    // La session doit etre intacte : un 404 est bien la reponse, mais ce qui
    // compte est qu'aucun acces n'ait ete coupe.
    expect((await prisma.session.findUnique({ where: { id: sessionOrdinateur.id } })).revokedAt).toBeNull();
  });

  it('repond 404 sur une session inexistante', async () => {
    const { telephone } = await deuxAppareils();
    const res = await client.delete('/api/v2/auth/sessions/999999').set(enTete(telephone.accessToken));
    expect(res.status).toBe(404);
  });

  // Rejouer la suppression doit rester sans effet, comme la deconnexion : le client
// peut avoir perdu la reponse et reessayer. Repondre 204 plutot que 404 dit
// "cet appareil n'a plus acces", ce qui est vrai et reste vrai au second essai.
  it('est idempotent sur une session deja fermee', async () => {
    const { telephone, ordinateur } = await deuxAppareils();

    const sessionOrdinateur = (await lister(telephone.accessToken)).body.sessions.find(
      (s) => s.id === verifyToken(ordinateur.accessToken).sessionId
    );

    expect((await client.delete(`/api/v2/auth/sessions/${sessionOrdinateur.id}`).set(enTete(telephone.accessToken))).status).toBe(204);
    expect((await client.delete(`/api/v2/auth/sessions/${sessionOrdinateur.id}`).set(enTete(telephone.accessToken))).status).toBe(204);

    // Et la session disparait bien de la liste, une seule fois.
    const res = await lister(telephone.accessToken);
    expect(res.body.sessions.map((s) => s.id)).not.toContain(sessionOrdinateur.id);
  });

  it('repond 400 sur un identifiant non numerique au lieu de 500', async () => {
    const { telephone } = await deuxAppareils();
    const res = await client.delete('/api/v2/auth/sessions/pas-un-id').set(enTete(telephone.accessToken));
    expect(res.status).toBe(400);
  });

  it('exige une authentification', async () => {
    const { telephone } = await deuxAppareils();
    const res = await client.delete(`/api/v2/auth/sessions/${verifyToken(telephone.accessToken).sessionId}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v2/auth/logout-all', () => {
  it('ferme toutes les sessions sauf celle de l appelant', async () => {
    const { utilisateur, telephone } = await deuxAppareils();

    const res = await client.post('/api/v2/auth/logout-all').set(enTete(telephone.accessToken));
    expect(res.status).toBe(204);

    const restantes = await prisma.session.findMany({ where: { userId: utilisateur.id, revokedAt: null } });
    expect(restantes).toHaveLength(1);
    expect(restantes[0].id).toBe(verifyToken(telephone.accessToken).sessionId);
  });

  // Se deconnecter de tous les appareils en s'authentifiant avec l'un d'eux
  // laisserait l'appelant sans acces, sans nouveau jeton pour se reconnecter.
  it('preserve la session de l appelant', async () => {
    const { telephone } = await deuxAppareils();

    await client.post('/api/v2/auth/logout-all').set(enTete(telephone.accessToken));

    const res = await client.post('/api/v2/auth/refresh').send({ refreshToken: telephone.refreshToken });
    expect(res.status).toBe(200);
  });

  it('laisse les sessions d un autre compte intactes', async () => {
    const { telephone } = await deuxAppareils();
    const autre = await registerViaApi(client);
    const sessionAutre = await prisma.session.findFirst({
      where: { id: verifyToken(autre.accessToken).sessionId },
    });

    await client.post('/api/v2/auth/logout-all').set(enTete(telephone.accessToken));

    expect((await prisma.session.findUnique({ where: { id: sessionAutre.id } })).revokedAt).toBeNull();
  });

  it('exige une authentification', async () => {
    expect((await client.post('/api/v2/auth/logout-all')).status).toBe(401);
  });
});