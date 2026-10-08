import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api } from '../helpers/app.js';
import { registerViaApi } from '../helpers/factory.js';
import { hashToken } from '../../src/utils/refreshToken.js';
import { generateToken, verifyToken } from '../../src/utils/jwt.js';

const client = api();

// Contenu verifiable du jeton sans passer par la reponse.
const claims = (token) => verifyToken(token);
const utilisateur = (email) => prisma.user.findUnique({ where: { email } });

describe('POST /api/v2/auth/register', () => {
  it('cree un compte et renvoie les jetons', async () => {
    const { user, accessToken, refreshToken } = await registerViaApi(client, { role: 'FARMER' });

    // role et userStatus sont exposes en { code, label } : le libelle pour
    // l'affichage, le code pour la logique du client. C'est la forme unique,
    // celle que renvoie aussi GET /api/v2/auth/me — voir utils/userApi.js.
    expect(user).toMatchObject({
      firstname: 'Amina',
      lastname: 'Benali',
      role: { code: 'FARMER', label: 'Agriculteur' },
      userStatus: { code: 'ACTIVE', label: 'Actif' },
      emailVerified: false,
    });
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
  });

  it("n'expose jamais le hash du mot de passe", async () => {
    const { user } = await registerViaApi(client);
    expect(user.password).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain('$2b$');
  });

  it('refuse un role hors liste blanche, meme envoye', async () => {
    for (const role of ['ADMIN', 'ROOT']) {
      const res = await client.post('/api/v2/auth/register').send({
        firstname: 'Malin',
        lastname: 'Intention',
        phone: '+33611110000',
        email: `${role.toLowerCase()}@example.com`,
        password: 'MotDePasse1!',
        role,
      });
      expect(res.status, `role ${role} doit etre refuse`).toBe(400);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuse un email deja utilise', async () => {
    await registerViaApi(client, { email: 'doublon@example.com' });
    const res = await client.post('/api/v2/auth/register').send({
      firstname: 'Autre',
      lastname: 'Personne',
      phone: '+33622220000',
      email: 'doublon@example.com',
      password: 'MotDePasse1!',
      role: 'BUYER',
    });
    expect(res.status).toBe(409);
  });

  it('refuse un mot de passe trop faible', async () => {
    const res = await client.post('/api/v2/auth/register').send({
      firstname: 'Faible',
      lastname: 'MotDePasse',
      phone: '+33633330000',
      email: 'faible@example.com',
      password: 'tropcourt',
      role: 'BUYER',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => d.field === 'password')).toBe(true);
  });
});

describe('POST /api/v2/auth/login', () => {
  it('accepte les identifiants valides', async () => {
    const { payload } = await registerViaApi(client, { email: 'login@example.com' });

    const res = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('renvoie le meme message pour email inconnu et mot de passe faux', async () => {
    const { payload } = await registerViaApi(client, { email: 'connu@example.com' });

    const inconnu = await client.post('/api/v2/auth/login').send({ email: 'inconnu@example.com', password: 'x' });
    const faux = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: 'MauvaisMotDePasse1!' });

    // Distinguer les deux cas permettrait d enumerer les comptes existants.
    expect(inconnu.status).toBe(401);
    expect(faux.status).toBe(401);
    expect(inconnu.body.error).toBe(faux.body.error);
  });

  it('bloque la connexion d un compte suspendu', async () => {
    const { payload } = await registerViaApi(client, { email: 'suspendu@example.com' });
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    const suspendu = await prisma.userStatus.findUnique({ where: { code: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: user.id }, data: { userStatusId: suspendu.id } });

    const res = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    expect(res.status).toBe(403);
  });
});

describe('Rotation du refresh token', () => {
  it('delivre un nouvel access token', async () => {
    const { refreshToken } = await registerViaApi(client);

    const res = await client.post('/api/v2/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  // Le logout revoque le jeton : le rejouer ne doit plus rien donner.
  it('ne reutilise pas un jeton revoque', async () => {
    const { refreshToken } = await registerViaApi(client);
    await client.post('/api/v2/auth/logout').send({ refreshToken });

    const res = await client.post('/api/v2/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('ne stocke que l empreinte du jeton', async () => {
    const { refreshToken } = await registerViaApi(client);
    const stored = await prisma.refreshToken.findMany();

    expect(stored).toHaveLength(1);
    expect(stored[0].token).not.toBe(refreshToken);
  });

  it('refuse un jeton expire', async () => {
    const { refreshToken } = await registerViaApi(client);
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await client.post('/api/v2/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});

// Avant cette phase, une deconnexion ne revocait que l'un des jetons du compte :
// les connexions concurrentes restaient valides, et rien ne pouvait dire de quel
// appareil venait une connexion. Une session est ce qui rend la deconnexion
// ciblee exprimable.
describe('Sessions', () => {
  const sessionsDe = (userId) => prisma.session.findMany({ where: { userId } });

  it('ouvre une session a l inscription', async () => {
    const { user } = await registerViaApi(client);

    const sessions = await sessionsDe(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).toBeNull();
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('ouvre une session a chaque connexion, sans reutiliser la precedente', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    const apresInscription = (await sessionsDe(user.id)).length;

    await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });
    await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });

    // L'inscription ouvre deja une session ; deux connexions de plus en ouvrent
    // deux autres. Deux appareils, deux sessions : c'est tout l'objet du modele,
    // puisqu'avant une reconnexion ne pouvait que se superposer a la precedente.
    const sessions = await sessionsDe(user.id);
    expect(apresInscription).toBe(1);
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.revokedAt === null)).toBe(true);
  });

  it('rattache le jeton de rafraichissement a sa session', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    const jeton = await prisma.refreshToken.findFirst({ where: { userId: user.id } });
    const session = await prisma.session.findFirst({ where: { id: jeton.sessionId } });

    expect(session.userId).toBe(user.id);
    expect(jeton.token).not.toBe(refreshToken);
  });

  it('enregistre l appareil quand la requete le renseigne', async () => {
    const { payload } = await registerViaApi(client, { email: 'appareil@example.com' });
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    await client
      .post('/api/v2/auth/login')
      .set('User-Agent', 'AgriConnect-Jest/1.0')
      .send({ email: payload.email, password: payload.password });

    // Agent et IP sont facultatifs, mais quand la requete les porte ils doivent
    // etre conserves : sans eux, "deconnecte cet appareil" n'a aucun sens.
    const derniere = (await sessionsDe(user.id)).sort((a, b) => b.id - a.id)[0];
    expect(derniere.userAgent).toBe('AgriConnect-Jest/1.0');
    expect(derniere.ip).toBeTruthy();
  });

  // Supertest n'envoie pas de User-Agent : la session doit quand meme etre creee,
  // faute de quoi un client qui masque son agent ne pourrait plus se connecter.
  it('ouvre une session meme sans agent ni IP', async () => {
    const { user } = await registerViaApi(client, { email: 'sans-agent@example.com' });

    const sessions = await sessionsDe(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userAgent).toBeNull();
  });

  it('ferme la session au logout, pas seulement le jeton', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    const res = await client.post('/api/v2/auth/logout').send({ refreshToken });
    expect(res.status).toBe(204);

    const sessions = await sessionsDe(user.id);
    expect(sessions[0].revokedAt).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { revoked: false } })).toBe(0);
  });

  // Fermer une session deja fermee doit rester sans effet : un client qui
  // rejoue sa deconnexion, ou qui n'a pas recu la reponse, ne doit pas obtenir
  // une erreur.
  it('rend le logout idempotent', async () => {
    const { refreshToken } = await registerViaApi(client);

    expect((await client.post('/api/v2/auth/logout').send({ refreshToken })).status).toBe(204);
    expect((await client.post('/api/v2/auth/logout').send({ refreshToken })).status).toBe(204);
  });

  it('ne coupe que la session de l appareil qui se deconnecte', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    const telephone = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    const ordinateur = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    await client.post('/api/v2/auth/logout').send({ refreshToken: telephone.body.refreshToken });

    // L'appareil qui s'est deconnecte ne peut plus rafraichir ; l'autre si.
    const coupe = await client.post('/api/v2/auth/refresh').send({ refreshToken: telephone.body.refreshToken });
    const intact = await client.post('/api/v2/auth/refresh').send({ refreshToken: ordinateur.body.refreshToken });

    expect(coupe.status).toBe(401);
    expect(intact.status).toBe(200);

    const actives = (await sessionsDe(user.id)).filter((s) => s.revokedAt === null);
    // Trois sessions au total : inscription, telephone, ordinateur. Une seule
    // est fermee, celle de l'appareil qui s'est deconnecte.
    expect(actives).toHaveLength(2);
  });

  // Un jeton peut rester valide alors que sa session a ete close : c'est
  // exactement le cas que la verification de session doit attraper.
  it('refuse le refresh quand la session a ete close', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    await prisma.session.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });

    const res = await client.post('/api/v2/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});

// La rotation remplace le jeton presents sans ouvrir de nouvelle session : c'est
// la session qui est l'unite de vie, pas le jeton. Un rafraichissement ne doit
// donc jamais faire grossir la liste des sessions d'un compte.
describe('Rotation du jeton dans la session', () => {
  const rafraichir = (refreshToken) => client.post('/api/v2/auth/refresh').send({ refreshToken });

  it('renvoie un nouveau jeton, different du presente', async () => {
    const { refreshToken } = await registerViaApi(client);

    const res = await rafraichir(refreshToken);

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it('rend le nouveau jeton immediatement utilisable', async () => {
    const { refreshToken } = await registerViaApi(client);

    const premier = await rafraichir(refreshToken);
    const second = await rafraichir(premier.body.refreshToken);

    expect(second.status).toBe(200);
    expect(second.body.accessToken).toBeTruthy();
  });

  it('marque le jeton remplace comme tel, en distinguant rotation et deconnexion', async () => {
    const { refreshToken } = await registerViaApi(client);
    await rafraichir(refreshToken);

    const ancien = await prisma.refreshToken.findFirst({ where: { token: hashToken(refreshToken) } });

    // rotatedAt dit que le jeton a ete remplace, replacedById pointe le
    // successeur. Sans cette distinction, un client legitime qui rejoue son
    // ancien jeton serait traite comme un voleur.
    expect(ancien.revoked).toBe(true);
    expect(ancien.rotatedAt).not.toBeNull();
    expect(ancien.replacedById).not.toBeNull();
  });

  it('conserve la session au lieu d en ouvrir une nouvelle', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    const res = await rafraichir(refreshToken);

    expect(res.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('met a jour la derniere activite de la session', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    // lastActivityAt se lit en millisecondes : on recule la valeur pour que la
    // difference soit observable sans dependre de la vitesse de l'horloge.
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { lastActivityAt: new Date(Date.now() - 60_000) },
    });
    await rafraichir(refreshToken);

    const apres = await prisma.session.findFirst({ where: { userId: user.id } });
    expect(apres.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
  });

  // Deux refreshs paralleles d'une app mobile discoverent en meme temps que le
  // jeton d'acces a expire. Le second presente donc un jeton que le premier vient
  // de remplacer : le serveur doit le tolérer, pas détruire la session.
  it('tolere un jeton represente dans la fenetre de tolerance', async () => {
    const { user, refreshToken } = await registerViaApi(client);

    const premier = await rafraichir(refreshToken);
    const second = await rafraichir(refreshToken);

    expect(second.status).toBe(200);
    expect(second.body.refreshToken).toBeTruthy();
    expect(second.body.refreshToken).not.toBe(premier.body.refreshToken);

    // Et la session doit rester utilisable par le client legitime.
    const troisieme = await rafraichir(premier.body.refreshToken);
    expect(troisieme.status).toBe(200);
    expect((await prisma.session.findFirst({ where: { userId: user.id } })).revokedAt).toBeNull();
  });

  // Hors tolerance, un jeton remplace ne peut plus appartenir au client : il est
  // traite comme vole et la session tombe entiere, car elle a pu eter volee avec.
  it('detecte un jeton rejoue hors tolerance et detruit la session', async () => {
    const { user, refreshToken } = await registerViaApi(client);
    await rafraichir(refreshToken);

    // On vieillit la rotation au-dela de la fenetre de 30 s.
    await prisma.refreshToken.updateMany({
      data: { rotatedAt: new Date(Date.now() - 31_000) },
    });

    const res = await rafraichir(refreshToken);
    expect(res.status).toBe(401);

    const session = await prisma.session.findFirst({ where: { userId: user.id } });
    expect(session.revokedAt).not.toBeNull();
    // Tous les jetons de la session tombent, pas seulement le jeton rejoue :
    // un voleur dispose en general de plusieurs jetons.
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0);
  });

  it('ne prolonge pas la tolerance au-dela du premier remplacement', async () => {
    const { refreshToken } = await registerViaApi(client);

    // La fenetre se mesure depuis le PREMIER remplacement. On simule un jeton
    // d'origine remplace il y a 29 s, represente depuis.
    const premier = await rafraichir(refreshToken);
    expect(premier.status).toBe(200);

    await prisma.refreshToken.updateMany({
      where: { token: hashToken(refreshToken) },
      data: { rotatedAt: new Date(Date.now() - 29_000) },
    });
    const tolere = await rafraichir(refreshToken);
    expect(tolere.status).toBe(200);

    // Le meme jeton, deux secondes plus tard, a depasse la fenetre d'origine :
    // il ne doit pas pouvoir repousser l'echeance indefiniment en etant represente
    // en boucle.
    await prisma.refreshToken.updateMany({
      where: { token: hashToken(refreshToken) },
      data: { rotatedAt: new Date(Date.now() - 31_000) },
    });
    const rejete = await rafraichir(refreshToken);
    expect(rejete.status).toBe(401);
  });
});

// Un compte ne doit pas pouvoir accumuler des sessions a l'infini depuis des
// appareils perdus : au-dela du plafond, la plus ancienne part.
describe('Plafond de sessions', () => {
  it('ferme la session la plus ancienne au-dela du plafond', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    for (let i = 0; i < 5; i += 1) {
      await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });
    }

    // 6 sessions ouvertes au total (inscription + 5 connexions), plafond a 5.
    const actives = await prisma.session.findMany({ where: { userId: user.id, revokedAt: null } });
    expect(actives).toHaveLength(5);

    // C'est la plus ancienne qui part, donc celle de l'inscription : on ne coupe
    // pas un appareil actif pour faire de la place a un nouvel arrivant.
    const premiere = await prisma.session.findFirst({
      where: { userId: user.id },
      orderBy: { id: 'asc' },
    });
    expect(premiere.revokedAt).not.toBeNull();
    expect(actives.map((s) => s.id)).not.toContain(premiere.id);
  });

  it('revoque aussi les jetons de la session evincee', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    // Le jeton de l'inscription, identifie avant de declencher les connexions.
    const inscription = await prisma.refreshToken.findFirst({ where: { userId: user.id } });
    for (let i = 0; i < 5; i += 1) {
      await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });
    }

    // Sans revocation du jeton, l'appareil evince pourrait encore rafraichir :
    // c'est donc la session qui ne suffit pas a couper un acces.
    const apres = await prisma.refreshToken.findUnique({ where: { id: inscription.id } });
    expect(apres.revoked).toBe(true);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(5);
  });

  it('laisse intactes les sessions en dessous du plafond', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    for (let i = 0; i < 4; i += 1) {
      await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });
    }

    // 5 sessions exactement : personne ne doit etre deconnecte.
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(5);
  });

  // Le plafond porte sur les sessions ouvertes, pas sur l'historique : un compte
  // qui s'est deconnecte puis reconnecte dix fois doit pouvoir le refaire.
  it('compte les sessions ouvertes, pas l historique', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });

    for (let i = 0; i < 4; i += 1) {
      await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });
    }
    // 5 sessions ouvertes. On en ferme 3 pour en laisser 2 : la nouvelle
    // connexion doit pouvoir passer sans evincer personne.
    const aFermer = await prisma.session.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { id: 'asc' },
      take: 3,
    });
    await prisma.session.updateMany({
      where: { id: { in: aFermer.map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });

    const res = await client.post('/api/v2/auth/login').send({ email: payload.email, password: payload.password });
    expect(res.status).toBe(200);
    // 3 sessions ouvertes, aucune eviction de supplement.
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(3);
  });
});

// Le client a besoin du statut du compte pour l'afficher sans refaire un appel, et
// du sessionId pour reconnaitre son appareil parmi les sessions qu'il liste.
describe('Charge utile du jeton d acces', () => {
  it('porte le statut, la verification et la session', async () => {
    const { accessToken } = await registerViaApi(client);

    const decoded = claims(accessToken);
    expect(Object.keys(decoded).sort()).toEqual(
      ['emailVerified', 'exp', 'iat', 'id', 'role', 'sessionId', 'userStatus'].sort()
    );
    expect(decoded.role).toBe('BUYER');
    expect(decoded.userStatus).toBe('ACTIVE');
    expect(decoded.emailVerified).toBe(false);
    expect(typeof decoded.sessionId).toBe('number');
  });

  it('rattache le sessionId a la session ouverte par cette connexion', async () => {
    const { accessToken, payload } = await registerViaApi(client);
    const user = await utilisateur(payload.email);

    const session = await prisma.session.findFirst({ where: { id: claims(accessToken).sessionId } });
    expect(session.userId).toBe(user.id);
  });

  it('remplace le sessionId a chaque connexion, sans le reutiliser', async () => {
    const { payload } = await registerViaApi(client);

    const premier = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    const second = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    // Deux appareils : le jeton de chacun designe sa propre session, sinon le
    // client ne pourrait pas se reconnaitre dans la liste.
    expect(claims(premier.body.accessToken).sessionId).not.toBe(claims(second.body.accessToken).sessionId);
  });

  it('conserve le sessionId apres un refresh', async () => {
    const { accessToken, refreshToken } = await registerViaApi(client);

    const res = await client.post('/api/v2/auth/refresh').send({ refreshToken });

    // La session ne change pas au refresh : seul le jeton qui la porte est
    // remplace, sinon le client perdrait la sienne a chaque renouvellement.
    expect(claims(res.body.accessToken).sessionId).toBe(claims(accessToken).sessionId);
  });

  it('expose aussi la verification dans la reponse de l inscription', async () => {
    const { user } = await registerViaApi(client);
    expect(user.emailVerified).toBe(false);
  });

  it('porte ACTIVE, et non le libelle, comme valeur de statut', async () => {
    const { payload } = await registerViaApi(client);
    await prisma.user.update({
      where: { email: payload.email },
      data: { emailVerified: true },
    });

    const res = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    // Les claims sont techniques : un client compare a "SUSPENDED", pas a
    // "Ce compte a été suspendu".
    expect(claims(res.body.accessToken).userStatus).toBe('ACTIVE');
    expect(claims(res.body.accessToken).emailVerified).toBe(true);
  });
});

// La base est la reference. Ces tests verrouillent le sens dans lequel l'ecart
// entre le jeton et la base se resorbe.
describe('Statut du compte : la base prime sur le jeton', () => {
  const routeProtegee = (token) => client.get('/api/v2/auth/me').set('Authorization', `Bearer ${token}`);

  it('refuse un jeton.delivre avant une suspension', async () => {
    const { accessToken, payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    const suspendu = await prisma.userStatus.findUnique({ where: { code: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: user.id }, data: { userStatusId: suspendu.id } });

    // Le jeton porte encore userStatus ACTIVE, il expire dans une heure. Sans
    // relecture en base, l'utilisateur suspendu disposerait d'une heure de plus.
    const res = await routeProtegee(accessToken);
    expect(res.status).toBe(403);
  });

  it('n accorde rien a un jeton qui se declare plus permissif que la base', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    const suspendu = await prisma.userStatus.findUnique({ where: { code: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: user.id }, data: { userStatusId: suspendu.id } });

    // Un jeton signe avec le vrai secret, mais portant un statut falsifie. Il est
    // valide au sens cryptographique : seule la relecture en base peut dire non.
    const falsifie = generateToken({
      id: user.id,
      role: user.role?.code ?? 'BUYER',
      userStatus: 'ACTIVE',
      emailVerified: false,
      sessionId: 1,
    });

    expect((await routeProtegee(falsifie)).status).toBe(403);
  });

  // Sens inverse : le jeton est perime, la base a rattrape. Refuser ici
  // deconnecterait un utilisateur qui vient de verifier son adresse.
  it('laisse passer un jeton anterieur a une verification d adresse', async () => {
    const { accessToken, payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });

    const res = await routeProtegee(accessToken);
    expect(res.status).toBe(200);
    // Le jeton dit encore false : c'est normal, il a jusqu'a une heure de validite,
    // et le client rafraichira. L'API, elle, est la source de verite.
    expect(claims(accessToken).emailVerified).toBe(false);
  });

  it('laisse passer un jeton anterieur a une levee de suspension', async () => {
    const { payload } = await registerViaApi(client);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    const suspendu = await prisma.userStatus.findUnique({ where: { code: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: user.id }, data: { userStatusId: suspendu.id } });

    const refuse = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    expect(refuse.status).toBe(403);

    const actif = await prisma.userStatus.findUnique({ where: { code: 'ACTIVE' } });
    await prisma.user.update({ where: { id: user.id }, data: { userStatusId: actif.id } });

    const res = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });
    expect(res.status).toBe(200);
    expect(claims(res.body.accessToken).userStatus).toBe('ACTIVE');
  });
});
