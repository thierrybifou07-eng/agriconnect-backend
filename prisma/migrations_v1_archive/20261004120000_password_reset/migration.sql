-- Phase 7 : reinitialisation de mot de passe.
--
-- Table separee de EmailVerificationToken, volontairement. Deux usages, deux
-- durees de vie (15 minutes contre 24 heures), deux facons de purger. Les
-- regrouper sous une colonne "type" ferait qu'une erreur de filtre envoie un
-- lien au mauvais effet — celui de verification verrait un mot de passe change.

-- CreateTable
CREATE TABLE `PasswordResetToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    -- 15 minutes. Un mot de passe se reinitialise sous le coup de la contrainte ;
    -- un lien qui traine des semaines dans une boite n'a plus lieu d'etre utile.
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PasswordResetToken_token_key`(`token`),
    INDEX `PasswordResetToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PasswordResetToken` ADD CONSTRAINT `PasswordResetToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;