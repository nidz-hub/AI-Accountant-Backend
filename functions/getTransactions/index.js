const { QueryCommand } = require("@aws-sdk/lib-dynamodb");

const { dynamoClient, TABLE_NAME } = require("../../shared/dynamoClient");
const { success, error } = require("../../shared/response");
const { USER_ID } = require("../../shared/constants");

exports.handler = async (event) => {
  try {
    const queryParams = event.queryStringParameters || {};

    // Hackathon auth: use the hardcoded demo user
    const userId = queryParams.userId || USER_ID;

    if (userId !== USER_ID) {
      return error("Invalid userId", 400);
    }

    const from = queryParams.from;
    const to = queryParams.to;

    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        }
      })
    );

    let transactions = result.Items || [];

    // Optional date filtering
    if (from) {
      transactions = transactions.filter(
        (transaction) => transaction.date >= from
      );
    }

    if (to) {
      transactions = transactions.filter(
        (transaction) => transaction.date <= to
      );
    }

    // Newest transactions first
    transactions.sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    return success({
      transactions
    });
  } catch (err) {
    console.error("Error getting transactions:", err);

    return error("Failed to get transactions", 500);
  }
};