const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const { dynamoClient, TABLE_NAME } = require("../../shared/dynamoClient");
const { success, error } = require("../../shared/response");
const {
  USER_ID
} = require("../../shared/constants");
const {
  validateTransaction,
  normalizeTransaction
} = require("../../shared/transactionSchema");

exports.handler = async (event) => {
  try {
    if (!event.body) {
      return error("Request body is required", 400);
    }

    let body;

    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return error("Request body must be valid JSON", 400);
    }

    // Force hackathon demo user
    body.userId = USER_ID;

    // Generate ID on the backend
    body.transactionId = randomUUID();

    const transaction = normalizeTransaction(body);

    const validation = validateTransaction(transaction);

    if (!validation.valid) {
      return error(validation.errors.join(", "), 400);
    }

    await dynamoClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: transaction,
        ConditionExpression:
          "attribute_not_exists(userId) AND attribute_not_exists(transactionId)"
      })
    );

    return success(
      {
        transaction
      },
      201
    );
  } catch (err) {
    console.error("Error creating transaction:", err);

    if (err.name === "ConditionalCheckFailedException") {
      return error("Transaction already exists", 409);
    }

    return error("Failed to create transaction", 500);
  }
};