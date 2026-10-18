import 'dotenv/config';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UPLOADS_ROOT, deleteFile } from '../src/services/storage.service.js';

// Repérage et suppression des fichiers présents dans uploads/ sans ligne Media
// qui les référence : uploads qui ont survécu à un rollback, à une entité
// supprimée, ou écrits avant l'enregistrement des publicId.
//
// Par défaut, le script ne fait QUEIT : il liste les orphelins et le volume
// qu'ils occupent. La suppression exige --apply, et ne touche jamais un fichier
// de moins de 24 h : un upload en cours (fichier écrit, ligne Media pas encore
// créée) passerait sinon pour un orphelin.
//
// node scripts/cleanup-orphan-uploads.js            → simulation
// node scripts/cleanup-orphan-uploads.js --apply    → suppression

// Âge minimal d'un fichier avant de le considérer supprimable : 24 h.
export const AGE_MINIMAL_MS = 24 * 60 * 60 * 1000;

/**
 * Fonction pure : détermine les fichiers orphelins parmi ceux présents sur le
 * disque. Aucune base, aucun système de fichiers — c'est ce qui la rend
 * testable unitairement.
 *
 * @param {Array<{publicId: string, size: number, mtimeMs: number}>} filesOnDisk
 *        Fichiers trouvés sous UPLOADS_ROOT, publicId au format Media.publicId
 *        (chemin relatif à la racine, séparateurs '/').
 * @param {Set<string>|Iterable<string>} referencedPublicIds
 *        publicId portés par au moins une ligne Media.
 * @param {Date|number} now  Instant de référence.
 * @param {number} minAgeMs  Âge minimal (now - mtimeMs) pour qu'un orphelin soit
 *        retenu : 0 pour lister tout, AGE_MINIMAL_MS pour ignorer les uploads
 *        en cours.
 * @returns {Array} Les orphelins (les objets d'origine), triés par publicId.
 */
export function findOrphans(filesOnDisk, referencedPublicIds, now, minAgeMs = 0) {
  const references =
    referencedPublicIds instanceof Set ? referencedPublicIds : new Set(referencedPublicIds);
  const instant = now instanceof Date ? now.getTime() : now;

  return filesOnDisk
    .filter((fichier) => !references.has(fichier.publicId) && instant - fichier.mtimeMs >= minAgeMs)
    .sort((a, b) => a.publicId.localeCompare(b.publicId));
}

/**
 * Parcourt récursivement un dossier et décrit chaque fichier.
 *
 * Le publicId est rendu avec des '/' quel que soit l'OS : c'est exactement le
 * format stocké dans Media.publicId par saveFile.
 *
 * @param {string} racine  Dossier à parcourir (UPLOADS_ROOT).
 * @param {string} [dossier]  Sous-dossier courant (usage interne).
 * @returns {Promise<Array<{publicId: string, size: number, mtimeMs: number}>>}
 */
export async function listFilesOnDisk(racine, dossier = racine) {
  const entrees = await readdir(dossier, { withFileTypes: true }).catch((err) => {
    // Un dossier uploads/ absent n'est pas une erreur : il n'y a rien à nettoyer.
    if (err.code === 'ENOENT') return [];
    throw err;
  });

  const fichiers = [];
  for (const entree of entrees) {
    const chemin = join(dossier, entree.name);
    if (entree.isDirectory()) {
      fichiers.push(...(await listFilesOnDisk(racine, chemin)));
    } else if (entree.isFile()) {
      const infos = await stat(chemin);
      fichiers.push({
        publicId: relative(racine, chemin).split(sep).join('/'),
        size: infos.size,
        mtimeMs: infos.mtimeMs,
      });
    }
  }
  return fichiers;
}

function formaterVolume(octets) {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(1)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * Compare le contenu de uploads/ aux publicId référencés en base.
 *
 * @param {object} options
 * @param {boolean} options.apply  true = supprimer, false = simulation.
 * @param {object} [options.prismaClient]  Client injecté (tests) ; par défaut
 *        le client du projet.
 * @returns {Promise<{orphelins: number, volume: number, supprimes: number,
 *   ignores: number, echecs: string[]}>}
 */
export async function cleanupOrphanUploads({ apply = false, prismaClient } = {}) {
  // Imports différés : findOrphans et listFilesOnDisk doivent rester utilisables
  // (et testables) sans base de données ni .env.
  let prisma = prismaClient;
  if (!prisma) {
    const { default: client } = await import('../src/config/prisma.js');
    prisma = client;
  }

  try {
    const [fichiers, medias] = await Promise.all([
      listFilesOnDisk(UPLOADS_ROOT),
      // Une ligne Media sans publicId ne référence aucun fichier : elle est
      // ignorée ici, et son fichier — s'il existe — reste considéré orphelin.
      prisma.media.findMany({ where: { publicId: { not: null } }, select: { publicId: true } }),
    ]);
    const references = new Set(medias.map((media) => media.publicId));
    const maintenant = new Date();

    const tousOrphelins = findOrphans(fichiers, references, maintenant, 0);
    // Un fichier de moins de 24 h peut être un upload en cours (écrit, pas encore
    // enregistré en base) : --apply l'ignore, la simulation le signale.
    const assezAncien = (fichier) => maintenant.getTime() - fichier.mtimeMs >= AGE_MINIMAL_MS;
    const recents = tousOrphelins.filter((fichier) => !assezAncien(fichier));
    const retenus = apply ? tousOrphelins.filter(assezAncien) : tousOrphelins;

    const volume = retenus.reduce((total, fichier) => total + fichier.size, 0);

    if (retenus.length === 0) {
      console.log(
        apply
          ? 'Aucun fichier orphelin à supprimer.'
          : `Aucun fichier orphelin dans ${UPLOADS_ROOT} (${fichiers.length} fichier(s) référencé(s) ou en cours).`
      );
    } else {
      console.log(
        `${apply ? 'Suppression' : 'Simulation'} : ${retenus.length} fichier(s) orphelin(s), ${formaterVolume(volume)}.`
      );
      for (const fichier of retenus) {
        console.log(`  - ${fichier.publicId} (${formaterVolume(fichier.size)})`);
      }
    }

    let supprimes = 0;
    const echecs = [];
    if (apply) {
      const resultats = await Promise.allSettled(retenus.map((fichier) => deleteFile(fichier.publicId)));
      resultats.forEach((resultat, index) => {
        if (resultat.status === 'fulfilled') supprimes += 1;
        else echecs.push(retenus[index].publicId);
      });
      console.log(
        `Suppression terminée : ${supprimes} fichier(s) supprimé(s), ${echecs.length} en échec.`
      );
    } else if (recents.length > 0) {
      console.log(
        `  ${recents.length} fichier(s) de moins de 24 h ignorés par --apply (upload en cours).`
      );
    }

    return {
      orphelins: retenus.length,
      volume,
      supprimes,
      ignores: recents.length,
      echecs,
    };
  } finally {
    // La connexion n'est fermée que si le script a ouvert la sienne.
    if (!prismaClient) await prisma.$disconnect();
  }
}

// Exécution directe : node scripts/cleanup-orphan-uploads.js [--apply]
const estExecutionDirecte =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (estExecutionDirecte) {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Mode simulation (aucune suppression). Ajoutez --apply pour effacer.');
  }
  cleanupOrphanUploads({ apply })
    .then(() => process.exit(0))
    .catch((erreur) => {
      console.error(erreur);
      process.exit(1);
    });
}