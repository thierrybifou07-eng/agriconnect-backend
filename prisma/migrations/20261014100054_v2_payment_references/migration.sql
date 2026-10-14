-- AlterTable
ALTER TABLE `SupplierCompensation` ADD COLUMN `paidById` INTEGER NULL,
    ADD COLUMN `reference` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Referral` ADD COLUMN `paidById` INTEGER NULL,
    ADD COLUMN `reference` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `SupplierCompensation` ADD CONSTRAINT `SupplierCompensation_paidById_fkey` FOREIGN KEY (`paidById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Referral` ADD CONSTRAINT `Referral_paidById_fkey` FOREIGN KEY (`paidById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

