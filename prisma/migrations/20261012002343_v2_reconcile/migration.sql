-- Vider OrderItem : MySQL refuse d'ajouter une colonne NOT NULL à une table
-- qui contient des lignes. La table est vide (vérifié avant migration) et ne
-- contient que des données de test (décision C4).
DELETE FROM `OrderItem`;

-- DropForeignKey
ALTER TABLE `Conversation` DROP FOREIGN KEY `Conversation_productId_fkey`;

-- AlterTable
ALTER TABLE `StockLot` MODIFY `qualityGrade` ENUM('A', 'B', 'C') NULL;

-- AlterTable
ALTER TABLE `LotQualityCheck` MODIFY `grade` ENUM('A', 'B', 'C') NOT NULL;

-- AlterTable
ALTER TABLE `Conversation` DROP COLUMN `productId`,
    ADD COLUMN `listingId` INTEGER NULL,
    ADD COLUMN `lotId` INTEGER NULL;

-- AlterTable
ALTER TABLE `OrderItem` ADD COLUMN `listingId` INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX `Conversation_listingId_idx` ON `Conversation`(`listingId`);

-- CreateIndex
CREATE INDEX `Conversation_lotId_idx` ON `Conversation`(`lotId`);

-- CreateIndex
CREATE INDEX `OrderItem_listingId_idx` ON `OrderItem`(`listingId`);

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_listingId_fkey` FOREIGN KEY (`listingId`) REFERENCES `Listing`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `StockLot`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_listingId_fkey` FOREIGN KEY (`listingId`) REFERENCES `Listing`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
