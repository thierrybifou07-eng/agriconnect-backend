import { describe, it, expect } from 'vitest';
import prisma from '../../src/config/prisma.js';
import { api, authHeader } from '../helpers/app.js';
import { createUser, registerViaApi } from '../helpers/factory.js';
import { generateToken } from '../../src/utils/jwt.js';

// B1 ne se limitait pas aux `select` : createAdmin et updateMe tentaient
// d'ecrire une colonne `fullName` inexistante. Ces tests le verifient a
// l'execution, la ou un controle statique des cles de select ne voit rien.

const client = api();

async function rootToken() {
  const root = await createUser({ role: 'ROOT' });
  return { root, token: generateToken({ id: root.id, role: 'ROOT' }) };
}

async function buyerToken() {
  const buyer = await createUser({ role: 'BUYER' });
  return { buyer, token: generateToken({ id: buyer.id, role: 'BUYER' }) };
}

async function adminToken() {
  const admin = await createUser({ role: 'ADMIN' });
  return { admin, token: generateToken({ id: admin.id, role: 'ADMIN' }) };
}

async function agentToken() {
  const agent = await createUser({ role: 'AGENT' });
  return { agent, token: generateToken({ id: agent.id, role: 'AGENT' }) };
}

// Matrice d'autorisation de la creation staff : ADMIN n'est delivable que par
// ROOT ; AGENT et DRIVER peuvent l'etre par un ADMIN ; en dessous du niveau 50
// la route refuse (requireMinLevel), avant toute validation du corps.
describe('POST /api/v2/admin/users - creation de comptes staff (ADMIN, AGENT, DRIVER)', () => {
  it('ROOT cree un administrateur', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Youssef',
      lastname: 'El Amrani',
      phone: '+33612345678',
      email: 'youssef@example.com',
      password: 'MotDePasse1!',
      role: 'ADMIN',
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      firstname: 'Youssef',
      lastname: 'El Amrani',
      role: { code: 'ADMIN', label: 'Administrateur' },
    });

    const enBase = await prisma.user.findUnique({ where: { email: 'youssef@example.com' } });
    expect(enBase).toBeTruthy();
  });

  it('n expose jamais le hash du mot de passe', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Yasmine',
      lastname: 'Tazi',
      phone: '+33612345679',
      email: 'yasmine@example.com',
      password: 'MotDePasse1!',
      role: 'ADMIN',
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.password).toBeUndefined();
  });

  it('refuse un prenom ou un nom manquant', async () => {
    const { token } = await rootToken();

    for (const payload of [
      { lastname: 'Tazi', phone: '+33612345680', password: 'MotDePasse1!', role: 'ADMIN' },
      { firstname: 'Yasmine', phone: '+33612345681', password: 'MotDePasse1!', role: 'ADMIN' },
    ]) {
      const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send(payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  it('ROOT cree un agent avec ses capacites', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Salma',
      lastname: 'Bennani',
      phone: '+33612345689',
      email: 'salma@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { displayName: 'Khadija Support', capabilities: ['BUYER_SUPPORT', 'ORDER_PROCESSING'] },
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.role).toMatchObject({ code: 'AGENT', label: 'Agent AgriConnect' });

    const enBase = await prisma.user.findUnique({ where: { email: 'salma@example.com' } });
    expect(enBase).toBeTruthy();
  });

  it('l agent cree a bien ses capacites en base', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Omar',
      lastname: 'Fassi',
      phone: '+33612345691',
      email: 'omar@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: ['BUYER_SUPPORT', 'ORDER_PROCESSING'] },
    });

    expect(res.status, res.text).toBe(201);

    // Le profil agent et ses lignes de liaison doivent exister : un compte
    // AGENT sans fiche Agent est un compte qui ne peut rien faire.
    const enBase = await prisma.user.findUnique({ where: { email: 'omar@example.com' } });
    const fiche = await prisma.agent.findUnique({ where: { userId: enBase.id } });
    expect(fiche).toBeTruthy();
    expect(fiche.kind).toBe('HUMAN');
    expect(fiche.displayName).toBe('Équipe AgriConnect');

    const liens = await prisma.agentCapabilityLink.findMany({
      where: { agentId: fiche.id },
      include: { capability: { select: { code: true } } },
    });
    expect(liens.map((lien) => lien.capability.code).sort()).toEqual(['BUYER_SUPPORT', 'ORDER_PROCESSING']);
  });

  it('ROOT cree un livreur rattache a son agence', async () => {
    const { token } = await rootToken();
    const agence = await prisma.transportAgency.create({
      data: { name: 'Agence de test', phone: '+33699999999' },
    });

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Rachid',
      lastname: 'Oukerzaz',
      phone: '+33612345690',
      email: 'rachid@example.com',
      password: 'MotDePasse1!',
      role: 'DRIVER',
      driver: { agencyId: agence.id, vehicleType: 'Moto', plateNumber: 'AA-123-BB' },
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.role).toMatchObject({ code: 'DRIVER', label: 'Livreur' });

    const enBase = await prisma.user.findUnique({ where: { email: 'rachid@example.com' } });
    const profil = await prisma.driverProfile.findUnique({ where: { userId: enBase.id } });
    expect(profil).toBeTruthy();
    expect(profil.agencyId).toBe(agence.id);
    expect(profil.vehicleType).toBe('Moto');
    expect(profil.plateNumber).toBe('AA-123-BB');
  });

  it('un administrateur ne peut pas creer un administrateur', async () => {
    const { token } = await adminToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Pirate',
      lastname: 'Intrus',
      phone: '+33612345682',
      email: 'pirate@example.com',
      password: 'MotDePasse1!',
      role: 'ADMIN',
    });

    expect(res.status, res.text).toBe(403);
  });

  it('un administrateur cree un agent', async () => {
    const { token } = await adminToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Nadia',
      lastname: 'Cherkaoui',
      phone: '+33612345683',
      email: 'nadia@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: ['SUPPLIER_SUPPORT'] },
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.role).toMatchObject({ code: 'AGENT', label: 'Agent AgriConnect' });
  });

  it('un administrateur cree un livreur', async () => {
    const { token } = await adminToken();
    const agence = await prisma.transportAgency.create({
      data: { name: 'Agence de test', phone: '+33699999998' },
    });

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Driss',
      lastname: 'Alaoui',
      phone: '+33612345684',
      email: 'driss@example.com',
      password: 'MotDePasse1!',
      role: 'DRIVER',
      driver: { agencyId: agence.id },
    });

    expect(res.status, res.text).toBe(201);
    expect(res.body.role).toMatchObject({ code: 'DRIVER', label: 'Livreur' });
  });

  it('refuse un agent : niveau insuffisant', async () => {
    const { token } = await agentToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Intrus',
      lastname: 'Agent',
      phone: '+33612345692',
      email: 'intrus-agent@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: [] },
    });

    expect(res.status, res.text).toBe(403);
  });

  it('refuse un acheteur : niveau insuffisant', async () => {
    const { token } = await buyerToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Intrus',
      lastname: 'Acheteur',
      phone: '+33612345693',
      email: 'intrus-acheteur@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: [] },
    });

    expect(res.status, res.text).toBe(403);
  });

  it('repond 409 quand l email existe deja', async () => {
    const { token } = await rootToken();
    const existant = await createUser({ role: 'BUYER' });

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Doublon',
      lastname: 'Email',
      phone: '+33612345687',
      email: existant.email,
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: [] },
    });

    expect(res.status, res.text).toBe(409);
  });

  it('repond 409 quand le numero existe deja', async () => {
    const { token } = await rootToken();
    const existant = await createUser({ role: 'BUYER' });

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Doublon',
      lastname: 'Telephone',
      phone: existant.phone,
      email: 'doublon-tel@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: [] },
    });

    expect(res.status, res.text).toBe(409);
  });

  it('refuse un livreur sans agence', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Sans',
      lastname: 'Agence',
      phone: '+33612345688',
      email: 'sans-agence@example.com',
      password: 'MotDePasse1!',
      role: 'DRIVER',
      driver: {},
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une agence inconnue', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Agence',
      lastname: 'Inconnue',
      phone: '+33612345694',
      email: 'agence-inconnue@example.com',
      password: 'MotDePasse1!',
      role: 'DRIVER',
      driver: { agencyId: 999999 },
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une agence inactive', async () => {
    const { token } = await rootToken();
    const agence = await prisma.transportAgency.create({
      data: { name: 'Agence inactive', phone: '+33699999997', isActive: false },
    });

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Agence',
      lastname: 'Inactive',
      phone: '+33612345685',
      email: 'agence-inactive@example.com',
      password: 'MotDePasse1!',
      role: 'DRIVER',
      driver: { agencyId: agence.id },
    });

    expect(res.status, res.text).toBe(400);
  });

  it('refuse une capacite inconnue', async () => {
    const { token } = await rootToken();

    const res = await client.post('/api/v2/admin/users').set(authHeader(token)).send({
      firstname: 'Capacite',
      lastname: 'Inconnue',
      phone: '+33612345686',
      email: 'capacite-inconnue@example.com',
      password: 'MotDePasse1!',
      role: 'AGENT',
      agent: { capabilities: ['BUYER_SUPPORT', 'TELEPATHIE'] },
    });

    expect(res.status, res.text).toBe(400);
  });
});

describe('GET /api/v2/admin/users - filtre profileVerificationStatus', () => {
  // Le filtre porte sur la verification du PROFIL (documents), distincte de
  // emailVerified. La reponse reste un tableau brut, comme avant l'ajout du
  // filtre : aucun client ne depend d une mise en forme pagination ici.
  it('ne renvoie que les comptes du statut demande', async () => {
    const { token } = await adminToken();
    const verifie = await createUser({ role: 'BUYER' });
    const enAttente = await createUser({ role: 'BUYER' });
    await prisma.user.update({ where: { id: verifie.id }, data: { profileVerificationStatus: 'VERIFIED' } });
    await prisma.user.update({ where: { id: enAttente.id }, data: { profileVerificationStatus: 'PENDING' } });

    const res = await client
      .get('/api/v2/admin/users?profileVerificationStatus=VERIFIED')
      .set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(verifie.id);
    expect(res.body[0].profileVerificationStatus).toBe('VERIFIED');
  });

  it('renvoie tous les comptes sans le filtre', async () => {
    const { token } = await adminToken();
    await createUser({ role: 'BUYER' });

    const res = await client.get('/api/v2/admin/users').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Forme unique de la reponse utilisateur', () => {
  // GET /api/v2/users/me renvoyait role et userStatus en lignes de base entieres
  // (id, level, isActive, createdAt) alors que register et login renvoyaient un
  // libelle. Deux formes pour le meme champ, dont une qui exposait des colonnes
  // internes. Tout passe maintenant par utils/userApi.js.
  it('expose role et userStatus en { code, label }, et rien de plus', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.role).toEqual({ code: 'BUYER', label: 'Acheteur' });
    expect(res.body.userStatus).toEqual({ code: 'ACTIVE', label: 'Actif' });
    // Les colonnes internes de Role et UserStatus ne doivent plus sortir.
    expect(res.body.role).not.toHaveProperty('level');
    expect(res.body.role).not.toHaveProperty('isActive');
    expect(res.body.role).not.toHaveProperty('createdAt');
    expect(res.body.userStatus).not.toHaveProperty('createdAt');
  });

  // "Qui suis-je" n'a pas besoin de coordonnees : le client connait sa propre
  // position, et les renvoyer ajoute une donnee sensible sans usage.
  it('ne renvoie pas les coordonnees', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({
      where: { id: buyer.id },
      data: { latitude: 34.02, longitude: -6.84 },
    });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.body.latitude).toBeUndefined();
    expect(res.body.longitude).toBeUndefined();
  });

  it('expose la verification d adresse', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({ where: { id: buyer.id }, data: { emailVerified: true } });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.body.emailVerified).toBe(true);
  });

  // La verification du PROFIL (examen des documents par l'équipe) est distincte
  // de celle de l'ADRESSE : l'une peut changer sans l'autre, et un compte frais
  // n'a ni l'une ni l'autre.
  it('expose la verification du profil, independante de l adresse', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.body.profileVerificationStatus).toBe('UNVERIFIED');
    expect(res.body.emailVerified).toBe(false);

    // Verifier l'adresse ne valide pas le profil.
    await prisma.user.update({ where: { id: buyer.id }, data: { emailVerified: true } });
    const adresseVerifiee = await client.get('/api/v2/auth/me').set(authHeader(token));
    expect(adresseVerifiee.body.emailVerified).toBe(true);
    expect(adresseVerifiee.body.profileVerificationStatus).toBe('UNVERIFIED');

    // Valider le profil ne dit rien sur l'adresse.
    await prisma.user.update({ where: { id: buyer.id }, data: { profileVerificationStatus: 'VERIFIED' } });
    const profilVerifie = await client.get('/api/v2/auth/me').set(authHeader(token));
    expect(profilVerifie.body.profileVerificationStatus).toBe('VERIFIED');
    expect(profilVerifie.body.emailVerified).toBe(true);
  });

  // La forme doit etre la meme partout : c'est register et login qui
  // s'alignent sur /me qui change, pas l'inverse.
  it('est la meme forme sur register, login et me', async () => {
    const { accessToken, user: inscrit, payload } = await registerViaApi(client, { role: 'SUPPLIER' });
    const me = await client.get('/api/v2/auth/me').set(authHeader(accessToken));
    const login = await client
      .post('/api/v2/auth/login')
      .send({ email: payload.email, password: payload.password });

    expect(login.status, login.text).toBe(200);

    const cles = (u) => Object.keys(u).sort().join(',');
    // /me porte en plus "media" et "profile", qui n'ont pas sa place dans une
    // inscription.
    expect(cles(me.body).replace(',media', '').replace(',profile', '')).toBe(cles(inscrit));
    expect(cles(login.body.user)).toBe(cles(inscrit));
    expect(inscrit.role).toEqual({ code: 'SUPPLIER', label: 'Fournisseur' });
  });

  it('conserve la liste des medias sur me', async () => {
    const { token } = await buyerToken();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(Array.isArray(res.body.media)).toBe(true);
  });
});

describe('Deplacement des routes profil hors de /api/v2/users', () => {
  // /api/v2/users est reserve aux endpoints d'administration a venir. Les quatre
  // routes y sont parties, et il n'y a pas de compatibilite : aucun client
  // n'existe encore, donc un point de deplacement explicite dans l'historique
  // vaut mieux qu'un shim qui aurait deux sources de verite.
  const anciennesRoutes = [
    ['get', '/api/v2/users/me'],
    ['patch', '/api/v2/users/me'],
    ['post', '/api/v2/users/me/avatar'],
    ['patch', '/api/v2/users/me/availability'],
  ];

  it.each(anciennesRoutes)('%s %s ne repond plus', async (methode, chemin) => {
    const { token } = await buyerToken();

    const res = await client[methode](chemin).set(authHeader(token)).send({});

    expect(res.status, `${methode.toUpperCase()} ${chemin} devrait etre gone`).toBe(404);
  });

  it('laisse le prefixe /api/v2/users entierement libre', async () => {
    const { token } = await buyerToken();

    // Aucune route sous /api/v2/users : ce prefixe est disponible pour la
    // future interface d'administration.
    for (const chemin of ['/api/v2/users', '/api/v2/users/1', '/api/v2/users/me']) {
      const res = await client.get(chemin).set(authHeader(token));
      expect(res.status, `GET ${chemin} devrait etre 404`).toBe(404);
    }
  });

  // Sansauthentification comprise : une route supprimee repond 404, pas 401.
  it('repond 404 sans jeton, et non 401', async () => {
    const res = await client.get('/api/v2/users/me');
    expect(res.status).toBe(404);
  });

  // La route de disponibilité du livreur a ete supprimee : la disponibilité se
  // déduit du statut du compte et des livraisons en cours, elle ne s'écrit plus.
  it('PATCH /api/v2/auth/me/availability ne repond plus', async () => {
    const { token } = await buyerToken();

    const res = await client.patch('/api/v2/auth/me/availability').set(authHeader(token)).send({});

    expect(res.status, 'PATCH /api/v2/auth/me/availability devrait etre gone').toBe(404);
  });
});

describe('PATCH /api/v2/auth/me - mise a jour du profil', () => {
  it('met a jour le prenom et le nom', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ firstname: 'Amina', lastname: 'Benali' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ firstname: 'Amina', lastname: 'Benali' });
  });

  // Les deux moities sont traitees separement : mettre a jour l'une ne doit
  // jamais effacer l'autre.
  it('ne modifie que le champ envoye', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.user.update({ where: { id: buyer.id }, data: { firstname: 'Fatima', lastname: 'Zahra' } });

    await client.patch('/api/v2/auth/me').set(authHeader(token)).send({ lastname: 'Alaoui' });

    const enBase = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(enBase.firstname).toBe('Fatima');
    expect(enBase.lastname).toBe('Alaoui');
  });

  it('met a jour la localisation et l email', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .patch('/api/v2/auth/me')
      .set(authHeader(token))
      .send({ location: 'Salé', email: 'nouveau@example.com' });

    expect(res.status, res.text).toBe(200);
    const enBase = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(enBase.location).toBe('Salé');
    expect(enBase.email).toBe('nouveau@example.com');
  });

  // Un corps vide ne doit rien changer, et surtout pas tout effacer.
  it('accepte une mise a jour vide sans rien modifier', async () => {
    const { buyer, token } = await buyerToken();
    const avant = await prisma.user.findUnique({ where: { id: buyer.id } });

    const res = await client.patch('/api/v2/auth/me').set(authHeader(token)).send({});

    expect(res.status, res.text).toBe(200);
    const apres = await prisma.user.findUnique({ where: { id: buyer.id } });
    expect(apres.firstname).toBe(avant.firstname);
    expect(apres.lastname).toBe(avant.lastname);
  });

  it('refuse une mise a jour sans authentification', async () => {
    const res = await client.patch('/api/v2/auth/me').send({ firstname: 'Intrus' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v2/auth/me - profil du role', () => {
  // Le profil vit dans une table par role ; /me l'expose tel quel, ou null
  // pour les comptes d equipe qui n'en ont pas.
  it('expose le profil BuyerProfile d un acheteur', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.buyerProfile.create({
      data: { userId: buyer.id, buyerType: 'WHOLESALER', businessName: 'Grossiste du Sud' },
    });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.profile).toMatchObject({
      userId: buyer.id,
      buyerType: 'WHOLESALER',
      businessName: 'Grossiste du Sud',
    });
  });

  it('expose le profil SupplierProfile d un fournisseur', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    const token = generateToken({ id: supplier.id, role: 'SUPPLIER' });
    await prisma.supplierProfile.create({
      data: { userId: supplier.id, farmName: 'Ferme des Oliviers', description: 'Olives et huile' },
    });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.profile).toMatchObject({
      userId: supplier.id,
      farmName: 'Ferme des Oliviers',
      description: 'Olives et huile',
    });
  });

  it('expose le profil DriverProfile d un livreur', async () => {
    const driver = await createUser({ role: 'DRIVER' });
    const token = generateToken({ id: driver.id, role: 'DRIVER' });
    const agence = await prisma.transportAgency.create({
      data: { name: 'Agence de test', phone: '+33699999996' },
    });
    await prisma.driverProfile.create({
      data: { userId: driver.id, agencyId: agence.id, vehicleType: 'Camion', plateNumber: 'CD-456-EF' },
    });

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.profile).toMatchObject({
      userId: driver.id,
      vehicleType: 'Camion',
      plateNumber: 'CD-456-EF',
    });
  });

  it('renvoie profile null pour un compte d equipe sans profil', async () => {
    const { token } = await adminToken();

    const res = await client.get('/api/v2/auth/me').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body.profile).toBeNull();
  });
});

describe('PATCH /api/v2/auth/me/profile', () => {
  it('met a jour le profil d un fournisseur', async () => {
    const supplier = await createUser({ role: 'SUPPLIER' });
    const token = generateToken({ id: supplier.id, role: 'SUPPLIER' });
    const zone = await prisma.zone.create({ data: { name: 'Zone de test' } });
    await prisma.supplierProfile.create({ data: { userId: supplier.id, farmName: 'Ancienne ferme' } });

    const res = await client
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ farmName: 'Nouvelle ferme', description: 'Maraîchage', zoneId: zone.id });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ farmName: 'Nouvelle ferme', description: 'Maraîchage', zoneId: zone.id });

    const enBase = await prisma.supplierProfile.findUnique({ where: { userId: supplier.id } });
    expect(enBase.farmName).toBe('Nouvelle ferme');
    expect(enBase.zoneId).toBe(zone.id);
  });

  it('met a jour le profil d un acheteur', async () => {
    const { buyer, token } = await buyerToken();
    const zone = await prisma.zone.create({ data: { name: 'Zone de test' } });
    await prisma.buyerProfile.create({ data: { userId: buyer.id, buyerType: 'RETAILER' } });

    const res = await client
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ buyerType: 'WHOLESALER', businessName: 'Grossiste du Sud', zoneId: zone.id });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ buyerType: 'WHOLESALER', businessName: 'Grossiste du Sud', zoneId: zone.id });
  });

  it('met a jour le profil d un livreur', async () => {
    const driver = await createUser({ role: 'DRIVER' });
    const token = generateToken({ id: driver.id, role: 'DRIVER' });
    const agence = await prisma.transportAgency.create({
      data: { name: 'Agence de test', phone: '+33699999995' },
    });
    await prisma.driverProfile.create({ data: { userId: driver.id, agencyId: agence.id } });

    const res = await client
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ vehicleType: 'Moto', plateNumber: 'AA-123-BB' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ vehicleType: 'Moto', plateNumber: 'AA-123-BB' });
  });

  it('repond 400 quand la zone n existe pas', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.buyerProfile.create({ data: { userId: buyer.id } });

    const res = await client
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ zoneId: 999999 });

    expect(res.status, res.text).toBe(400);
  });

  it('ignore les champs d un autre role', async () => {
    // Un acheteur qui envoie farmName (champ fournisseur) ne doit ni le voir
    // applique ni declencher d erreur : stripUnknown du schema par role
    // l'elimine avant l ecriture.
    const { buyer, token } = await buyerToken();
    await prisma.buyerProfile.create({ data: { userId: buyer.id, buyerType: 'RETAILER' } });

    const res = await client
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ farmName: 'Ferme intruse', buyerType: 'FARMER' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ buyerType: 'FARMER' });
    expect(res.body.farmName).toBeUndefined();
  });

  it('repond 403 pour un administrateur', async () => {
    const { token } = await adminToken();

    const res = await client.patch('/api/v2/auth/me/profile').set(authHeader(token)).send({ farmName: 'X' });

    expect(res.status, res.text).toBe(403);
  });

  it('repond 403 pour un agent', async () => {
    const { token } = await agentToken();

    const res = await client.patch('/api/v2/auth/me/profile').set(authHeader(token)).send({ buyerType: 'FARMER' });

    expect(res.status, res.text).toBe(403);
  });

  it('accepte la mise a jour pour un livreur, qui a un profil', async () => {
    // Un livreur a bien un profil (DriverProfile) : la route lui est ouverte,
    // a la difference des comptes d equipe.
    const driver = await createUser({ role: 'DRIVER' });
    const token = generateToken({ id: driver.id, role: 'DRIVER' });
    const agence = await prisma.transportAgency.create({
      data: { name: 'Agence de test', phone: '+33699999994' },
    });
    await prisma.driverProfile.create({ data: { userId: driver.id, agencyId: agence.id } });

    const res = await client
      .patch('/api/v2/auth/me/profile')
      .set(authHeader(token))
      .send({ vehicleType: 'Vélo' });

    expect(res.status, res.text).toBe(200);
  });
});

describe('Comptes de paiement - /api/v2/auth/me/payout-accounts', () => {
  const numero = '1234567890';

  it('cree un compte et n expose jamais le numero complet', async () => {
    const { buyer, token } = await buyerToken();

    const res = await client
      .post('/api/v2/auth/me/payout-accounts')
      .set(authHeader(token))
      .send({ method: 'MOBILE_MONEY', provider: 'Orange Money', accountNumber: numero, accountName: 'Amina Benali' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.accountNumberMasked).toBe('••••7890');
    expect(res.body.accountNumber).toBeUndefined();
    expect(res.body).toMatchObject({ method: 'MOBILE_MONEY', provider: 'Orange Money', isDefault: false });
  });

  it('liste les comptes du connecte, masques', async () => {
    const { buyer, token } = await buyerToken();
    await prisma.payoutAccount.create({
      data: { userId: buyer.id, method: 'BANK_TRANSFER', accountNumber: numero },
    });

    const res = await client.get('/api/v2/auth/me/payout-accounts').set(authHeader(token));

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].accountNumberMasked).toBe('••••7890');
    expect(res.body[0].accountNumber).toBeUndefined();
  });

  it('met a jour un compte', async () => {
    const { buyer, token } = await buyerToken();
    const compte = await prisma.payoutAccount.create({
      data: { userId: buyer.id, method: 'MOBILE_MONEY', accountNumber: numero },
    });

    const res = await client
      .patch(`/api/v2/auth/me/payout-accounts/${compte.id}`)
      .set(authHeader(token))
      .send({ accountName: 'Nouveau nom' });

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: compte.id, accountName: 'Nouveau nom', accountNumberMasked: '••••7890' });
  });

  it('supprime un compte', async () => {
    const { buyer, token } = await buyerToken();
    const compte = await prisma.payoutAccount.create({
      data: { userId: buyer.id, method: 'CASH', accountNumber: numero },
    });

    const res = await client.delete(`/api/v2/auth/me/payout-accounts/${compte.id}`).set(authHeader(token));

    expect(res.status, res.text).toBe(204);
    const enBase = await prisma.payoutAccount.findUnique({ where: { id: compte.id } });
    expect(enBase).toBeNull();
  });

  it('ne garde qu un seul compte par defaut', async () => {
    const { buyer, token } = await buyerToken();
    const premier = await prisma.payoutAccount.create({
      data: { userId: buyer.id, method: 'MOBILE_MONEY', accountNumber: numero, isDefault: true },
    });

    // Le second passe par defaut : le premier doit perdre le flag, en base
    // comme dans la reponse.
    const res = await client
      .post('/api/v2/auth/me/payout-accounts')
      .set(authHeader(token))
      .send({ method: 'BANK_TRANSFER', accountNumber: '0987654321', isDefault: true });

    expect(res.status, res.text).toBe(201);
    expect(res.body.isDefault).toBe(true);

    const enBase = await prisma.payoutAccount.findMany({ where: { userId: buyer.id } });
    const defauts = enBase.filter((c) => c.isDefault);
    expect(defauts).toHaveLength(1);
    expect(defauts[0].id).not.toBe(premier.id);
  });

  it('repond 404 quand le compte appartient a un autre', async () => {
    const { buyer, token } = await buyerToken();
    const autre = await createUser({ role: 'BUYER' });
    const compte = await prisma.payoutAccount.create({
      data: { userId: autre.id, method: 'MOBILE_MONEY', accountNumber: numero },
    });

    const resPatch = await client
      .patch(`/api/v2/auth/me/payout-accounts/${compte.id}`)
      .set(authHeader(token))
      .send({ accountName: 'Pirate' });
    expect(resPatch.status, resPatch.text).toBe(404);

    const resDelete = await client.delete(`/api/v2/auth/me/payout-accounts/${compte.id}`).set(authHeader(token));
    expect(resDelete.status, resDelete.text).toBe(404);
  });

  it('repond 403 pour un livreur', async () => {
    const driver = await createUser({ role: 'DRIVER' });
    const token = generateToken({ id: driver.id, role: 'DRIVER' });

    const res = await client.get('/api/v2/auth/me/payout-accounts').set(authHeader(token));

    expect(res.status, res.text).toBe(403);
  });

  it('repond 403 pour un administrateur', async () => {
    const { token } = await adminToken();

    const res = await client.get('/api/v2/auth/me/payout-accounts').set(authHeader(token));

    expect(res.status, res.text).toBe(403);
  });
});