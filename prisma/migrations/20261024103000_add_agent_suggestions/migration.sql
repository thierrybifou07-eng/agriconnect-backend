-- CreateTable
CREATE TABLE `AgentSuggestion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agentId` INTEGER NOT NULL,
    `kind` ENUM('REPLY', 'TRIAGE', 'LISTING_DRAFT') NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `conversationId` INTEGER NULL,
    `lotId` INTEGER NULL,
    `payload` JSON NULL,
    `model` VARCHAR(120) NOT NULL,
    `latencyMs` INTEGER NULL,
    `error` VARCHAR(500) NULL,
    `decidedByUserId` INTEGER NULL,
    `decidedAt` DATETIME(3) NULL,
    `executedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AgentSuggestion_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AgentSuggestion_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AgentSuggestion_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
