const {
  TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
  CURRENCY
} = require("./constants");

function validateTransaction(transaction) {
  const errors = [];

  if (!transaction.userId) {
    errors.push("userId is required");
  }

  if (!transaction.date) {
    errors.push("date is required");
  }

  if (!TRANSACTION_TYPES) {
    errors.push("Transaction types are not configured");
  }

  if (!["sale", "expense", "purchase"].includes(transaction.type)) {
    errors.push("type must be sale, expense, or purchase");
  }

  if (!transaction.item) {
    errors.push("item is required");
  }

  if (
    transaction.quantity === undefined ||
    transaction.quantity === null ||
    Number.isNaN(Number(transaction.quantity))
  ) {
    errors.push("quantity must be a number");
  }

  if (!transaction.unit) {
    errors.push("unit is required");
  }

  if (
    transaction.pricePerUnit === undefined ||
    transaction.pricePerUnit === null ||
    Number.isNaN(Number(transaction.pricePerUnit))
  ) {
    errors.push("pricePerUnit must be a number");
  }

  if (
    transaction.totalAmount === undefined ||
    transaction.totalAmount === null ||
    Number.isNaN(Number(transaction.totalAmount))
  ) {
    errors.push("totalAmount must be a number");
  }

  if (transaction.currency !== CURRENCY) {
    errors.push(`currency must be ${CURRENCY}`);
  }

  if (
    transaction.source &&
    !Object.values(TRANSACTION_SOURCES).includes(transaction.source)
  ) {
    errors.push("source must be photo, voice, or manual");
  }

  if (
    transaction.confidence !== undefined &&
    (Number(transaction.confidence) < 0 ||
      Number(transaction.confidence) > 1)
  ) {
    errors.push("confidence must be between 0 and 1");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function normalizeTransaction(transaction) {
  return {
    transactionId: transaction.transactionId,
    userId: transaction.userId,
    date: transaction.date,
    type: transaction.type,
    item: transaction.item,
    quantity: Number(transaction.quantity),
    unit: transaction.unit,
    pricePerUnit: Number(transaction.pricePerUnit),
    totalAmount: Number(transaction.totalAmount),
    currency: transaction.currency || CURRENCY,
    counterparty: transaction.counterparty || null,
    source: transaction.source || "manual",
    rawInput: transaction.rawInput || "",
    confidence:
      transaction.confidence === undefined
        ? 1
        : Number(transaction.confidence)
  };
}

module.exports = {
  validateTransaction,
  normalizeTransaction
};