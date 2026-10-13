-- AlterTable
ALTER TABLE `User` DROP COLUMN `isAvailable`,
    DROP COLUMN `vehicleType`,
    ADD COLUMN `profileVerificationStatus` ENUM('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED') NOT NULL DEFAULT 'UNVERIFIED',
    ADD COLUMN `profileVerifiedAt` DATETIME(3) NULL,
    ADD COLUMN `profileVerifiedById` INTEGER NULL,
    ADD COLUMN `referralCode` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_referralCode_key` ON `User`(`referralCode`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_profileVerifiedById_fkey` FOREIGN KEY (`profileVerifiedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Rôles v2 : FARMER devient SUPPLIER (meme id, les comptes existants suivent),
-- AGENT rejoint la table (niveau 30, entre opérationnel et administrateur).
UPDATE `Role` SET `code`='SUPPLIER', `label`='Fournisseur' WHERE `code`='FARMER';
INSERT INTO `Role` (`code`,`label`,`level`,`isActive`,`createdAt`)
  SELECT 'AGENT','Agent AgriConnect',30,1,NOW(3)
  WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `code`='AGENT');
