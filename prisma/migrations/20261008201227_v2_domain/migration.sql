-- VIDAGE DES DONNÉES MARKETPLACE V1 (données de test, décision C4)
-- MySQL refuse d'ajouter une colonne NOT NULL à une table qui contient
-- des lignes : on vide donc les données de test AVANT les ALTER.
-- L'ordre respecte les clés étrangères : les enfants avant les parents.

DELETE FROM `Delivery`;
DELETE FROM `Order`;
DELETE FROM `Message`;
DELETE FROM `Conversation`;
DELETE FROM `Media` WHERE `ownerListingId` IS NOT NULL;
DELETE FROM `Listing`;
-- DropForeignKey
ALTER TABLE `Media` DROP FOREIGN KEY `Media_ownerListingId_fkey`;

-- DropForeignKey
ALTER TABLE `Listing` DROP FOREIGN KEY `Listing_farmerId_fkey`;

-- DropForeignKey
ALTER TABLE `Listing` DROP FOREIGN KEY `Listing_categoryId_fkey`;

-- DropForeignKey
ALTER TABLE `Listing` DROP FOREIGN KEY `Listing_statusId_fkey`;

-- DropForeignKey
ALTER TABLE `Conversation` DROP FOREIGN KEY `Conversation_listingId_fkey`;

-- DropForeignKey
ALTER TABLE `Conversation` DROP FOREIGN KEY `Conversation_buyerId_fkey`;

-- DropForeignKey
ALTER TABLE `Conversation` DROP FOREIGN KEY `Conversation_farmerId_fkey`;

-- DropForeignKey
ALTER TABLE `Message` DROP FOREIGN KEY `Message_conversationId_fkey`;

-- DropForeignKey
ALTER TABLE `Message` DROP FOREIGN KEY `Message_senderId_fkey`;

-- DropForeignKey
ALTER TABLE `Order` DROP FOREIGN KEY `Order_listingId_fkey`;

-- DropForeignKey
ALTER TABLE `Order` DROP FOREIGN KEY `Order_farmerId_fkey`;

-- DropForeignKey
ALTER TABLE `Delivery` DROP FOREIGN KEY `Delivery_orderId_fkey`;

-- DropForeignKey
ALTER TABLE `Delivery` DROP FOREIGN KEY `Delivery_driverId_fkey`;

-- DropIndex
DROP INDEX `Media_ownerListingId_idx` ON `Media`;

-- DropIndex
DROP INDEX `Conversation_listingId_buyerId_key` ON `Conversation`;

-- DropIndex
DROP INDEX `Message_conversationId_idx` ON `Message`;

-- DropIndex
DROP INDEX `Order_farmerId_idx` ON `Order`;

-- DropIndex
DROP INDEX `Order_listingId_idx` ON `Order`;

-- DropIndex
DROP INDEX `Delivery_orderId_key` ON `Delivery`;

-- DropIndex
DROP INDEX `Delivery_driverId_idx` ON `Delivery`;

-- DropIndex
DROP INDEX `Delivery_status_idx` ON `Delivery`;

-- AlterTable
ALTER TABLE `Media` DROP COLUMN `ownerListingId`,
    ADD COLUMN `isPrivate` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `ownerLotId` INTEGER NULL,
    ADD COLUMN `ownerVerificationDocumentId` INTEGER NULL,
    ADD COLUMN `position` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `publicId` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `Conversation` DROP COLUMN `buyerId`,
    DROP COLUMN `farmerId`,
    DROP COLUMN `listingId`,
    ADD COLUMN `assignedAgentId` INTEGER NULL,
    ADD COLUMN `customerId` INTEGER NOT NULL,
    ADD COLUMN `escalatedAt` DATETIME(3) NULL,
    ADD COLUMN `escalationReason` TEXT NULL,
    ADD COLUMN `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `productId` INTEGER NULL,
    ADD COLUMN `status` ENUM('OPEN', 'WAITING_CUSTOMER', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    ADD COLUMN `subject` VARCHAR(191) NULL,
    ADD COLUMN `type` ENUM('BUYER_SUPPORT', 'SUPPLIER_SUPPORT') NOT NULL;

-- AlterTable
ALTER TABLE `Message` DROP COLUMN `read`,
    DROP COLUMN `senderId`,
    ADD COLUMN `isInternal` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `readAt` DATETIME(3) NULL,
    ADD COLUMN `senderAgentId` INTEGER NULL,
    ADD COLUMN `senderType` ENUM('CUSTOMER', 'AGENT', 'SYSTEM') NOT NULL,
    ADD COLUMN `senderUserId` INTEGER NULL;

-- AlterTable
ALTER TABLE `Order` DROP COLUMN `farmerId`,
    DROP COLUMN `listingId`,
    DROP COLUMN `quantity`,
    DROP COLUMN `totalPrice`,
    DROP COLUMN `unitPrice`,
    ADD COLUMN `buyerFee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `cancellationReason` TEXT NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL,
    ADD COLUMN `commissionTotal` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `completedAt` DATETIME(3) NULL,
    ADD COLUMN `confirmedAt` DATETIME(3) NULL,
    ADD COLUMN `conversationId` INTEGER NULL,
    ADD COLUMN `deliveryFee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `deliveryZoneId` INTEGER NULL,
    ADD COLUMN `handledByAgentId` INTEGER NULL,
    ADD COLUMN `notes` TEXT NULL,
    ADD COLUMN `orderNumber` VARCHAR(191) NOT NULL,
    ADD COLUMN `paymentStatus` ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED') NOT NULL DEFAULT 'UNPAID',
    ADD COLUMN `pickupHubId` INTEGER NULL,
    ADD COLUMN `reservedUntil` DATETIME(3) NULL,
    ADD COLUMN `subtotal` DECIMAL(14, 2) NOT NULL,
    ADD COLUMN `total` DECIMAL(14, 2) NOT NULL,
    MODIFY `status` ENUM('QUOTED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'QUOTED';

-- AlterTable
ALTER TABLE `Delivery` DROP COLUMN `assignedAt`,
    ADD COLUMN `acceptedAt` DATETIME(3) NULL,
    ADD COLUMN `agencyCost` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `agencyId` INTEGER NOT NULL,
    ADD COLUMN `dropoffAddress` TEXT NOT NULL,
    ADD COLUMN `failureReason` TEXT NULL,
    ADD COLUMN `incidentNote` TEXT NULL,
    ADD COLUMN `insurancePolicyNumber` VARCHAR(191) NULL,
    ADD COLUMN `insuredValue` DECIMAL(14, 2) NULL,
    ADD COLUMN `pickupAddress` TEXT NULL,
    ADD COLUMN `pickupHubId` INTEGER NULL,
    ADD COLUMN `proofOfDeliveryUrl` VARCHAR(500) NULL,
    MODIFY `status` ENUM('PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    MODIFY `deliveryFee` DECIMAL(14, 2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE `ListingStatus`;

-- DropTable
DROP TABLE `ListingCategory`;

-- DropTable
DROP TABLE `Listing`;

-- CreateTable
CREATE TABLE `ProductCategory` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ProductCategory_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Unit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Unit_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentCapability` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AgentCapability_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupplierProfile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `farmName` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `zoneId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SupplierProfile_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BuyerProfile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `buyerType` ENUM('RETAILER', 'FARMER', 'WHOLESALER', 'OTHER') NOT NULL DEFAULT 'RETAILER',
    `businessName` VARCHAR(191) NULL,
    `zoneId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BuyerProfile_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DriverProfile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `agencyId` INTEGER NOT NULL,
    `vehicleType` VARCHAR(191) NULL,
    `plateNumber` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DriverProfile_userId_key`(`userId`),
    INDEX `DriverProfile_agencyId_idx`(`agencyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PayoutAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `method` ENUM('MOBILE_MONEY', 'BANK_TRANSFER', 'CASH') NOT NULL,
    `provider` VARCHAR(191) NULL,
    `accountNumber` VARCHAR(64) NOT NULL,
    `accountName` VARCHAR(191) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PayoutAccount_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VerificationDocument` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `type` ENUM('ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER') NOT NULL,
    `status` ENUM('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reviewedById` INTEGER NULL,
    `reviewedAt` DATETIME(3) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VerificationDocument_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LegalDocument` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LegalDocument_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LegalDocumentVersion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `documentId` INTEGER NOT NULL,
    `version` VARCHAR(20) NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LegalDocumentVersion_documentId_status_idx`(`documentId`, `status`),
    UNIQUE INDEX `LegalDocumentVersion_documentId_version_key`(`documentId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LegalDocumentTranslation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `versionId` INTEGER NOT NULL,
    `locale` VARCHAR(5) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `content` LONGTEXT NOT NULL,

    UNIQUE INDEX `LegalDocumentTranslation_versionId_locale_key`(`versionId`, `locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TermsAcceptance` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `versionId` INTEGER NOT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `acceptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TermsAcceptance_userId_versionId_key`(`userId`, `versionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Agent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` ENUM('HUMAN', 'AI') NOT NULL DEFAULT 'HUMAN',
    `displayName` VARCHAR(191) NOT NULL,
    `userId` INTEGER NULL,
    `autonomy` ENUM('SUGGEST_ONLY', 'ACT_WITH_APPROVAL', 'AUTONOMOUS') NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `aiProvider` VARCHAR(191) NULL,
    `aiModel` VARCHAR(191) NULL,
    `aiConfig` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Agent_userId_key`(`userId`),
    INDEX `Agent_kind_isActive_idx`(`kind`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentCapabilityLink` (
    `agentId` INTEGER NOT NULL,
    `capabilityId` INTEGER NOT NULL,

    PRIMARY KEY (`agentId`, `capabilityId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Zone` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `city` VARCHAR(191) NULL,
    `region` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Zone_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransportAgency` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `contactName` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `insuranceProvider` VARCHAR(191) NULL,
    `insurancePolicyNumber` VARCHAR(191) NULL,
    `insuranceExpiresAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TransportAgency_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgencyZone` (
    `agencyId` INTEGER NOT NULL,
    `zoneId` INTEGER NOT NULL,
    `baseFee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `perKmFee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`agencyId`, `zoneId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Hub` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `address` TEXT NOT NULL,
    `city` VARCHAR(191) NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `zoneId` INTEGER NOT NULL,
    `acceptsDropoff` BOOLEAN NOT NULL DEFAULT true,
    `acceptsPickup` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `categoryId` INTEGER NOT NULL,
    `unitId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `imageUrl` VARCHAR(500) NULL,
    `isPerishable` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Product_unitId_idx`(`unitId`),
    UNIQUE INDEX `Product_categoryId_name_key`(`categoryId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockLot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lotCode` VARCHAR(191) NOT NULL,
    `supplierId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `zoneId` INTEGER NOT NULL,
    `storageType` ENUM('SUPPLIER_SITE', 'HUB') NOT NULL DEFAULT 'SUPPLIER_SITE',
    `hubId` INTEGER NULL,
    `pickupAddress` TEXT NULL,
    `pickupLatitude` DOUBLE NULL,
    `pickupLongitude` DOUBLE NULL,
    `agreedUnitPrice` DECIMAL(14, 2) NOT NULL,
    `quantityInitial` DECIMAL(12, 3) NOT NULL,
    `quantityAvailable` DECIMAL(12, 3) NOT NULL,
    `quantityReserved` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `quantitySold` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `quantityLost` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `packagingNote` VARCHAR(191) NULL,
    `qualityNote` VARCHAR(191) NULL,
    `harvestedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `status` ENUM('PENDING_VALIDATION', 'AVAILABLE', 'FULLY_RESERVED', 'SOLD_OUT', 'EXPIRED', 'RETURNED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING_VALIDATION',
    `createdByAgentId` INTEGER NULL,
    `validatedByAgentId` INTEGER NULL,
    `validatedAt` DATETIME(3) NULL,
    `rejectionReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StockLot_lotCode_key`(`lotCode`),
    INDEX `StockLot_status_productId_zoneId_idx`(`status`, `productId`, `zoneId`),
    INDEX `StockLot_supplierId_idx`(`supplierId`),
    INDEX `StockLot_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockMovement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lotId` INTEGER NOT NULL,
    `type` ENUM('RECEIVED', 'RESERVED', 'RESERVATION_RELEASED', 'SOLD', 'EXPIRED', 'RETURNED', 'ADJUSTMENT') NOT NULL,
    `quantityDelta` DECIMAL(12, 3) NOT NULL,
    `orderItemId` INTEGER NULL,
    `note` VARCHAR(191) NULL,
    `actorUserId` INTEGER NULL,
    `actorAgentId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StockMovement_lotId_createdAt_idx`(`lotId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `lotId` INTEGER NOT NULL,
    `deliveryId` INTEGER NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitPrice` DECIMAL(14, 2) NOT NULL,
    `supplierUnitPrice` DECIMAL(14, 2) NOT NULL,
    `lineTotal` DECIMAL(14, 2) NOT NULL,
    `commissionRate` DECIMAL(5, 4) NOT NULL,
    `commissionAmount` DECIMAL(14, 2) NOT NULL,
    `supplierNetAmount` DECIMAL(14, 2) NOT NULL,

    INDEX `OrderItem_orderId_idx`(`orderId`),
    INDEX `OrderItem_lotId_idx`(`lotId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `method` ENUM('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER') NOT NULL,
    `status` ENUM('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `provider` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(100) NULL,
    `paidAt` DATETIME(3) NULL,
    `recordedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Payment_idempotencyKey_key`(`idempotencyKey`),
    INDEX `Payment_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupplierPayout` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `supplierId` INTEGER NOT NULL,
    `grossAmount` DECIMAL(14, 2) NOT NULL,
    `commissionAmount` DECIMAL(14, 2) NOT NULL,
    `netAmount` DECIMAL(14, 2) NOT NULL,
    `status` ENUM('ON_HOLD', 'READY', 'PAID', 'CANCELLED') NOT NULL DEFAULT 'ON_HOLD',
    `payoutAccountId` INTEGER NULL,
    `reference` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `paidById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SupplierPayout_supplierId_status_idx`(`supplierId`, `status`),
    UNIQUE INDEX `SupplierPayout_orderId_supplierId_key`(`orderId`, `supplierId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupplierCompensation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `supplierId` INTEGER NOT NULL,
    `lotId` INTEGER NOT NULL,
    `deliveryId` INTEGER NULL,
    `reason` ENUM('EXPIRED_UNSOLD', 'LOST_OR_DAMAGED', 'OTHER') NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitPrice` DECIMAL(14, 2) NOT NULL,
    `rate` DECIMAL(5, 4) NOT NULL DEFAULT 1,
    `amount` DECIMAL(14, 2) NOT NULL,
    `status` ENUM('PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
    `note` TEXT NULL,
    `approvedById` INTEGER NULL,
    `approvedAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SupplierCompensation_supplierId_status_idx`(`supplierId`, `status`),
    INDEX `SupplierCompensation_lotId_idx`(`lotId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Referral` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `referrerId` INTEGER NOT NULL,
    `referredId` INTEGER NOT NULL,
    `kind` ENUM('BUYER', 'SUPPLIER') NOT NULL,
    `status` ENUM('PENDING', 'ELIGIBLE', 'PAID', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `rewardAmount` DECIMAL(14, 2) NULL,
    `eligibleAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `rejectionReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Referral_referredId_key`(`referredId`),
    INDEX `Referral_referrerId_status_idx`(`referrerId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformSetting` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'XAF',
    `supplierCommissionRate` DECIMAL(5, 4) NOT NULL DEFAULT 0,
    `buyerFeeType` ENUM('NONE', 'FIXED', 'PERCENT') NOT NULL DEFAULT 'NONE',
    `buyerFeeValue` DECIMAL(14, 4) NOT NULL DEFAULT 0,
    `transportMarkupRate` DECIMAL(5, 4) NOT NULL DEFAULT 0,
    `referralBuyerReward` DECIMAL(14, 2) NOT NULL DEFAULT 5000,
    `referralSupplierReward` DECIMAL(14, 2) NOT NULL DEFAULT 10000,
    `reservationHours` INTEGER NOT NULL DEFAULT 24,
    `expiryCompensationRate` DECIMAL(5, 4) NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actorUserId` INTEGER NULL,
    `actorAgentId` INTEGER NULL,
    `action` VARCHAR(80) NOT NULL,
    `entityType` VARCHAR(50) NOT NULL,
    `entityId` INTEGER NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `AuditLog_actorUserId_createdAt_idx`(`actorUserId`, `createdAt`),
    INDEX `AuditLog_actorAgentId_createdAt_idx`(`actorAgentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Media_ownerLotId_idx` ON `Media`(`ownerLotId`);

-- CreateIndex
CREATE INDEX `Media_ownerVerificationDocumentId_idx` ON `Media`(`ownerVerificationDocumentId`);

-- CreateIndex
CREATE INDEX `User_profileVerificationStatus_idx` ON `User`(`profileVerificationStatus`);

-- CreateIndex
CREATE INDEX `Conversation_customerId_idx` ON `Conversation`(`customerId`);

-- CreateIndex
CREATE INDEX `Conversation_status_lastMessageAt_idx` ON `Conversation`(`status`, `lastMessageAt`);

-- CreateIndex
CREATE INDEX `Conversation_assignedAgentId_status_idx` ON `Conversation`(`assignedAgentId`, `status`);

-- CreateIndex
CREATE INDEX `Message_conversationId_createdAt_idx` ON `Message`(`conversationId`, `createdAt`);

-- CreateIndex
CREATE UNIQUE INDEX `Order_orderNumber_key` ON `Order`(`orderNumber`);

-- CreateIndex
CREATE INDEX `Order_buyerId_status_idx` ON `Order`(`buyerId`, `status`);

-- CreateIndex
CREATE INDEX `Order_status_createdAt_idx` ON `Order`(`status`, `createdAt`);

-- CreateIndex
CREATE INDEX `Delivery_agencyId_status_idx` ON `Delivery`(`agencyId`, `status`);

-- CreateIndex
CREATE INDEX `Delivery_driverId_status_idx` ON `Delivery`(`driverId`, `status`);

-- CreateIndex
CREATE INDEX `Delivery_orderId_idx` ON `Delivery`(`orderId`);

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_ownerLotId_fkey` FOREIGN KEY (`ownerLotId`) REFERENCES `StockLot`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_ownerVerificationDocumentId_fkey` FOREIGN KEY (`ownerVerificationDocumentId`) REFERENCES `VerificationDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierProfile` ADD CONSTRAINT `SupplierProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierProfile` ADD CONSTRAINT `SupplierProfile_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `Zone`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BuyerProfile` ADD CONSTRAINT `BuyerProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BuyerProfile` ADD CONSTRAINT `BuyerProfile_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `Zone`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DriverProfile` ADD CONSTRAINT `DriverProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DriverProfile` ADD CONSTRAINT `DriverProfile_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `TransportAgency`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayoutAccount` ADD CONSTRAINT `PayoutAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VerificationDocument` ADD CONSTRAINT `VerificationDocument_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VerificationDocument` ADD CONSTRAINT `VerificationDocument_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LegalDocumentVersion` ADD CONSTRAINT `LegalDocumentVersion_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `LegalDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LegalDocumentTranslation` ADD CONSTRAINT `LegalDocumentTranslation_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `LegalDocumentVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TermsAcceptance` ADD CONSTRAINT `TermsAcceptance_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TermsAcceptance` ADD CONSTRAINT `TermsAcceptance_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `LegalDocumentVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Agent` ADD CONSTRAINT `Agent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentCapabilityLink` ADD CONSTRAINT `AgentCapabilityLink_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentCapabilityLink` ADD CONSTRAINT `AgentCapabilityLink_capabilityId_fkey` FOREIGN KEY (`capabilityId`) REFERENCES `AgentCapability`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgencyZone` ADD CONSTRAINT `AgencyZone_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `TransportAgency`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgencyZone` ADD CONSTRAINT `AgencyZone_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `Zone`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Hub` ADD CONSTRAINT `Hub_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `Zone`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `ProductCategory`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_unitId_fkey` FOREIGN KEY (`unitId`) REFERENCES `Unit`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockLot` ADD CONSTRAINT `StockLot_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `SupplierProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockLot` ADD CONSTRAINT `StockLot_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockLot` ADD CONSTRAINT `StockLot_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `Zone`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockLot` ADD CONSTRAINT `StockLot_hubId_fkey` FOREIGN KEY (`hubId`) REFERENCES `Hub`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockLot` ADD CONSTRAINT `StockLot_createdByAgentId_fkey` FOREIGN KEY (`createdByAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockLot` ADD CONSTRAINT `StockLot_validatedByAgentId_fkey` FOREIGN KEY (`validatedByAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `StockLot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `OrderItem`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_actorAgentId_fkey` FOREIGN KEY (`actorAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_assignedAgentId_fkey` FOREIGN KEY (`assignedAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_senderUserId_fkey` FOREIGN KEY (`senderUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_senderAgentId_fkey` FOREIGN KEY (`senderAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_handledByAgentId_fkey` FOREIGN KEY (`handledByAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_pickupHubId_fkey` FOREIGN KEY (`pickupHubId`) REFERENCES `Hub`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_deliveryZoneId_fkey` FOREIGN KEY (`deliveryZoneId`) REFERENCES `Zone`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `StockLot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_deliveryId_fkey` FOREIGN KEY (`deliveryId`) REFERENCES `Delivery`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayout` ADD CONSTRAINT `SupplierPayout_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayout` ADD CONSTRAINT `SupplierPayout_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `SupplierProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayout` ADD CONSTRAINT `SupplierPayout_payoutAccountId_fkey` FOREIGN KEY (`payoutAccountId`) REFERENCES `PayoutAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayout` ADD CONSTRAINT `SupplierPayout_paidById_fkey` FOREIGN KEY (`paidById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCompensation` ADD CONSTRAINT `SupplierCompensation_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `SupplierProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCompensation` ADD CONSTRAINT `SupplierCompensation_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `StockLot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCompensation` ADD CONSTRAINT `SupplierCompensation_deliveryId_fkey` FOREIGN KEY (`deliveryId`) REFERENCES `Delivery`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCompensation` ADD CONSTRAINT `SupplierCompensation_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Delivery` ADD CONSTRAINT `Delivery_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `TransportAgency`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Delivery` ADD CONSTRAINT `Delivery_driverId_fkey` FOREIGN KEY (`driverId`) REFERENCES `DriverProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Delivery` ADD CONSTRAINT `Delivery_pickupHubId_fkey` FOREIGN KEY (`pickupHubId`) REFERENCES `Hub`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Referral` ADD CONSTRAINT `Referral_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Referral` ADD CONSTRAINT `Referral_referredId_fkey` FOREIGN KEY (`referredId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorAgentId_fkey` FOREIGN KEY (`actorAgentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Renommage des modes de livraison v1 vers les codes v2.
-- PICKUP -> HUB_PICKUP, DELIVERY -> AGENCY_DELIVERY (mêmes ids : les
-- commandes éventuelles suivent).

UPDATE `DeliveryMode` SET `code`='HUB_PICKUP', `label`='Retrait en point de dépôt' WHERE `code`='PICKUP';
UPDATE `DeliveryMode` SET `code`='AGENCY_DELIVERY', `label`='Livraison par l''agence' WHERE `code`='DELIVERY';
