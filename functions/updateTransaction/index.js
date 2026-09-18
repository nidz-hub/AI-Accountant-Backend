const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const { dynamoClient, TABLE_NAME } = require("../../shared/dynamoClient");
const { success, error } = require("../../shared/response");
const { USER_ID } = require("../../shared/constants");

const ALLOWED_FIELDS = [
  "date",
  "type",
  "item",
  "quantity",
  "unit",
  "pricePerUnit",
  "totalAmount",
  "currency",
  "counterparty",
  "source",
  "rawInput",
  "confidence"
];

exports.handler = async (event) => {
  try {
    const transactionId = event.pathParameters?.transactionId;

    if (!transactionId) {
      return error("transactionId is required", 400);
    }

    if (!event.body) {
      return error("Request body is required", 400);
    }

    let body;

    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return error("Request body must be valid JSON", 400);
    }

    const updates = {};

    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return error("No valid fields provided for update", 400);
    }

    if (updates.quantity !== undefined) {
      updates.quantity = Number(updates.quantity);

      if (Number.isNaN(updates.quantity)) {
        return error("quantity must be a number", 400);
      }
    }

    if (updates.pricePerUnit !== undefined) {
      updates.pricePerUnit = Number(updates.pricePerUnit);

      if (Number.isNaN(updates.pricePerUnit)) {
        return error("pricePerUnit must be a number", 400);
      }
    }

    if (updates.totalAmount !== undefined) {
      updates.totalAmount = Number(updates.totalAmount);

      if (Number.isNaN(updates.totalAmount)) {
        return error("totalAmount must be a number", 400);
      }
    }

    if (updates.confidence !== undefined) {
      updates.confidence = Number(updates.confidence);

      if (
        Number.isNaN(updates.confidence) ||
        updates.confidence < 0 ||
        updates.confidence > 1
      ) {
        return error("confidence must be between 0 and 1", 400);
      }
    }

    const setExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    for (const [field, value] of Object.entries(updates)) {
      setExpressions.push(`#${field} = :${field}`);
      expressionAttributeNames[`#${field}`] = field;
      expressionAttributeValues[`:${field}`] = value;
    }

    const result = await dynamoClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          userId: USER_ID,
          transactionId
        },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression:
          "attribute_exists(userId) AND attribute_exists(transactionId)",
        ReturnValues: "ALL_NEW"
      })
    );

    return success({
      transaction: result.Attributes
    });
  } catch (err) {
    console.error("Error updating transaction:", err);

    if (err.name === "ConditionalCheckFailedException") {
      return error("Transaction not found", 404);
    }

    return error("Failed to update transaction", 500);
  }
};