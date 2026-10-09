-- AlterTable
ALTER TABLE `stocklot` ADD COLUMN `qualityGrade` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `LotQualityCheck` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lotId` INTEGER NOT NULL,
    `grade` VARCHAR(1) NOT NULL,
    `notes` TEXT NULL,
    `inspectedByUserId` INTEGER NULL,
    `inspectedByAgentId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LotQualityCheck_lotId_createdAt_idx`(`lotId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LotQualityCheck` ADD CONSTRAINT `LotQualityCheck_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `StockLot`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LotQualityCheck` ADD CONSTRAINT `LotQualityCheck_inspectedByUserId_fkey` FOREIGN KEY (`inspectedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LotQualityCheck` ADD CONSTRAINT `LotQualityCheck_inspectedByAgentId_fkey` FOREIGN KEY (`inspectedByAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Delivery` ADD CONSTRAINT `Delivery_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
