export const ProfileVerification = {
    UNVERIFIED: 'UNVERIFIED',
    PENDING: 'PENDING',
    VERIFIED: 'VERIFIED',
    REJECTED: 'REJECTED'
}

export const UserRoleCode = {
    ROOT: 'ROOT',
    ADMIN: 'ADMIN',
    SUPPLIER: 'SUPPLIER',
    BUYER: 'BUYER',
    AGENT: 'AGENT',
    DRIVER: 'DRIVER'
}
export const DocumentType = {
    ID_CARD: 'ID_CARD',
    BUSINESS_REGISTRATION: 'BUSINESS_REGISTRATION',
    FARM_PROOF: 'FARM_PROOF',
    OTHER: 'OTHER',
}

export const BuyerType = {
    RETAILER: 'RETAILER',
    FARMER: 'FARMER',
    WHOLESALER: 'WHOLESALER',
    OTHER: 'OTHER',
}

export const PayoutMethod = {
    MOBILE_MONEY: 'MOBILE_MONEY',
    BANK_TRANSFER: 'BANK_TRANSFER',
    CASH: 'CASH',
}

export const StorageType = {
    SUPPLIER_SITE: 'SUPPLIER_SITE',
    HUB: 'HUB',
}

export const UserStatusCode = {
    ACTIVE: 'ACTIVE',
    SUSPENDED: 'SUSPENDED'
}
export const LotStatusCode = {
    PENDING_VALIDATION: 'PENDING_VALIDATION',
    AVAILABLE: 'AVAILABLE',
    FULLY_RESERVED: 'FULLY_RESERVED',
    SOLD_OUT: 'SOLD_OUT',
    EXPIRED: 'EXPIRED',
    RETURNED: 'RETURNED',
    REJECTED: 'REJECTED',
    WITHDRAWN: 'WITHDRAWN',
}

export const StockMovementTypeCode = {
    RECEIVED: 'RECEIVED',
    RESERVED: 'RESERVED',
    RESERVATION_RELEASED: 'RESERVATION_RELEASED',
    SOLD: 'SOLD',
    EXPIRED: 'EXPIRED',
    RETURNED: 'RETURNED',
    ADJUSTMENT: 'ADJUSTMENT',
}

export const OrderStatus = {
    QUOTED: 'QUOTED',
    CONFIRMED: 'CONFIRMED',
    PREPARING: 'PREPARING',
    READY_FOR_PICKUP: 'READY_FOR_PICKUP',
    OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED'
}

export const PaymentStatus = {
    UNPAID: 'UNPAID',
    PARTIALLY_PAID: 'PARTIALLY_PAID',
    PAID: 'PAID',
    REFUNDED: 'REFUNDED',
}

export const PaymentMethod = {
    CASH: 'CASH',
    MOBILE_MONEY: 'MOBILE_MONEY',
    BANK_TRANSFER: 'BANK_TRANSFER',
}

export const PaymentEntryStatus = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
}

export const PayoutStatus = {
    ON_HOLD: 'ON_HOLD',
    READY: 'READY',
    PAID: 'PAID',
    CANCELLED: 'CANCELLED',
}

export const DeliveryStatus = {
    PENDING: 'PENDING',
    ACCEPTED: 'ACCEPTED',
    PICKED_UP: 'PICKED_UP',
    IN_TRANSIT: 'IN_TRANSIT',
    DELIVERED: 'DELIVERED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
}

export const CompensationReason = {
    EXPIRED_UNSOLD: 'EXPIRED_UNSOLD',
    LOST_OR_DAMAGED: 'LOST_OR_DAMAGED',
    OTHER: 'OTHER',
}

export const CompensationStatus = {
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    APPROVED: 'APPROVED',
    PAID: 'PAID',
    REJECTED: 'REJECTED',
}

export const ReferralKind = {
    BUYER: 'BUYER',
    SUPPLIER: 'SUPPLIER',
}

export const ReferralStatus = {
    PENDING: 'PENDING',
    ELIGIBLE: 'ELIGIBLE',
    PAID: 'PAID',
    REJECTED: 'REJECTED',
}

export const BuyerFeeType = {
    NONE: 'NONE',
    FIXED: 'FIXED',
    PERCENT: 'PERCENT',
}

export const AgentKind = {
    HUMAN: 'HUMAN',
    AI: 'AI',
}

export const AgentAutonomy = {
    SUGGEST_ONLY: 'SUGGEST_ONLY',
    ACT_WITH_APPROVAL: 'ACT_WITH_APPROVAL',
    AUTONOMOUS: 'AUTONOMOUS',
}

export const ConversationType = {
    BUYER_SUPPORT: 'BUYER_SUPPORT',
    SUPPLIER_SUPPORT: 'SUPPLIER_SUPPORT',
}

export const ConversationStatus = {
    OPEN: 'OPEN',
    WAITING_CUSTOMER: 'WAITING_CUSTOMER',
    CLOSED: 'CLOSED',
}

export const SenderType = {
    CUSTOMER: 'CUSTOMER',
    AGENT: 'AGENT',
    SYSTEM: 'SYSTEM',
}

export const QualityGrade = {
    A: 'A',
    B: 'B',
    C: 'C',
}

export const LegalVersionStatus = {
    DRAFT: 'DRAFT',
    PUBLISHED: 'PUBLISHED',
    ARCHIVED: 'ARCHIVED',
}
export const ListingStatusCode = {
    ACTIVE:'ACTIVE',
    INACTIVE:'INACTIVE',
    DRAFT:'DRAFT',
    SOLD:'SOLD'
}