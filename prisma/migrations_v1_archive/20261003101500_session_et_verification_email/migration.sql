-- Phase 1 : la session devient une entite a part entiere.
--
-- RefreshToken etait un sac plat par utilisateur : rien ne distinguait deux
-- connexions du meme compte. Une deconnexion ne revocait que l'un des jetons,
-- les autres restaient valides, et "deconnecte moi de cet appareil" n'etait pas
-- exprimable. La session est ce qui rend la deconnexion ciblee possible, et ce
-- qui permet a une reinitialisation de mot de passe de couper tous les acces
-- d'un coup.

-- CreateTable
CREATE TABLE `Session` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `userAgent` VARCHAR(191) NULL,
    `ip` VARCHAR(191) NULL,
    `lastActivityAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
--
-- rotatedAt separe une rotation d'une revocation, ce que le seul booleen
-- "revoked" ne permettait pas. replacedById pointe le jeton qui a succede a
-- celui-ci : sans ce pointeur, la fenetre de tolerance de 30 secondes ne
-- pourrait que refuser l'appel, alors que l'appel est legitime.
ALTER TABLE `RefreshToken`
    ADD COLUMN `rotatedAt` DATETIME(3) NULL,
    ADD COLUMN `replacedById` INTEGER NULL;

CREATE INDEX `RefreshToken_replacedById_idx` ON `RefreshToken`(`replacedById`);

-- Rattachement des jetons existants.
--
-- sessionId est NOT NULL : un jeton sans session ne doit pas exister. Plutot
-- que de rendre la colonne nullable puis de la laisser ainsi, chaque
-- utilisateur concerne recoit une session de transition, close a sa creation.
-- Une session close et tracable vaut mieux qu'une absence de session, qui
-- rendrait la rupture invisible a la relecture de la base.
INSERT INTO `Session` (`userId`, `lastActivityAt`, `expiresAt`, `revokedAt`, `createdAt`)
SELECT `userId`, CURRENT_TIMESTAMP(3), MAX(`expiresAt`), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `RefreshToken`
GROUP BY `userId`;

ALTER TABLE `RefreshToken` ADD COLUMN `sessionId` INTEGER NULL;

-- La table vient d'etre creee et ne contient que ces sessions de transition :
-- il y en a donc exactement une par utilisateur, ce qui rend le jointure
-- non ambiguë.
UPDATE `RefreshToken` AS rt
JOIN `Session` AS s ON s.`userId` = rt.`userId`
SET rt.`sessionId` = s.`id`;

-- Si un jeton s'etait echappe au rattachement, cette contrainte echouerait
-- avec un message explicite, la ou la colonne nullable aurait laisse passer
-- un jeton sans session en silence.
ALTER TABLE `RefreshToken` MODIFY `sessionId` INTEGER NOT NULL;

CREATE INDEX `RefreshToken_sessionId_idx` ON `RefreshToken`(`sessionId`);

-- Les jetons anterieurs sont revoques : ils n'ont pas d'antecedent de session
-- reels et ne peuvent donc pas etre rattaches honnetement. Cette base ne
-- contient que des donnees experimentales, et la session de transition qui les
-- porte est deja close.
UPDATE `RefreshToken` SET `revoked` = true WHERE `revoked` = false;

-- Renommage de "verified" en "emailVerified". Le nom seul ne disait pas ce qui
-- etait verifie, et l'indicateur est desormais expose dans le jeton d'acces.
-- CHANGE COLUMN plutot que DROP/ADD pour conserver la colonne ; la valeur
-- n'est pas perdue, meme si elle n'a jamais ete ecrite par le code.
ALTER TABLE `User` CHANGE COLUMN `verified` `emailVerified` BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_replacedById_fkey` FOREIGN KEY (`replacedById`) REFERENCES `RefreshToken`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;