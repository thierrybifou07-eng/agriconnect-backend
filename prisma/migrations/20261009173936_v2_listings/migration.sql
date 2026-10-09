-- AlterTable
ALTER TABLE `media` ADD COLUMN `ownerListingId` INTEGER NULL;

-- CreateTable
CREATE TABLE `ListingStatus` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ListingStatus_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Listing` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reference` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `unitPrice` DECIMAL(14, 2) NOT NULL,
    `productId` INTEGER NOT NULL,
    `zoneId` INTEGER NOT NULL,
    `statusId` INTEGER NOT NULL,
    `publishedAt` DATETIME(3) NULL,
    `createdByUserId` INTEGER NULL,
    `createdByAgentId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Listing_reference_key`(`reference`),
    INDEX `Listing_statusId_idx`(`statusId`),
    INDEX `Listing_productId_idx`(`productId`),
    INDEX `Listing_zoneId_idx`(`zoneId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ListingLot` (
    `listingId` INTEGER NOT NULL,
    `lotId` INTEGER NOT NULL,

    PRIMARY KEY (`listingId`, `lotId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Media_ownerListingId_idx` ON `Media`(`ownerListingId`);

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_ownerListingId_fkey` FOREIGN KEY (`ownerListingId`) REFERENCES `Listing`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `Zone`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_statusId_fkey` FOREIGN KEY (`statusId`) REFERENCES `ListingStatus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_createdByAgentId_fkey` FOREIGN KEY (`createdByAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingLot` ADD CONSTRAINT `ListingLot_listingId_fkey` FOREIGN KEY (`listingId`) REFERENCES `Listing`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingLot` ADD CONSTRAINT `ListingLot_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `StockLot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
