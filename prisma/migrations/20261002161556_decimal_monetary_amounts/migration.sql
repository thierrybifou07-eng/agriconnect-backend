-- AlterTable
ALTER TABLE `delivery` MODIFY `deliveryFee` DECIMAL(10, 2) NULL;

-- AlterTable
ALTER TABLE `listing` MODIFY `price` DECIMAL(10, 2) NOT NULL,
    MODIFY `quantity` DECIMAL(12, 3) NOT NULL;

-- AlterTable
ALTER TABLE `order` MODIFY `quantity` DECIMAL(12, 3) NOT NULL,
    MODIFY `unitPrice` DECIMAL(10, 2) NOT NULL,
    MODIFY `totalPrice` DECIMAL(10, 2) NOT NULL;
