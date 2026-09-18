const { QueryCommand } = require("@aws-sdk/lib-dynamodb");

const { dynamoClient, TABLE_NAME } = require("../../shared/dynamoClient");
const { success, error } = require("../../shared/response");
const { USER_ID } = require("../../shared/constants");

exports.handler = async (event) => {
  try {
    const queryParams = event.queryStringParameters || {};

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

    let totalSales = 0;
    let totalExpenses = 0;

    const itemTotals = {};
    const dailyTotals = {};

    for (const transaction of transactions) {
      const amount = Number(transaction.totalAmount) || 0;

      if (transaction.type === "sale") {
        totalSales += amount;
      }

      if (
        transaction.type === "expense" ||
        transaction.type === "purchase"
      ) {
        totalExpenses += amount;
      }

      if (transaction.item) {
        itemTotals[transaction.item] =
          (itemTotals[transaction.item] || 0) + amount;
      }

      if (transaction.date) {
        const day = transaction.date.slice(0, 10);

        if (!dailyTotals[day]) {
          dailyTotals[day] = {
            date: day,
            sales: 0,
            expenses: 0
          };
        }

        if (transaction.type === "sale") {
          dailyTotals[day].sales += amount;
        }

        if (
          transaction.type === "expense" ||
          transaction.type === "purchase"
        ) {
          dailyTotals[day].expenses += amount;
        }
      }
    }

    const topItems = Object.entries(itemTotals)
      .map(([item, amount]) => ({
        item,
        amount
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    const dailySeries = Object.values(dailyTotals).sort(
      (a, b) => a.date.localeCompare(b.date)
    );

    const netProfit = totalSales - totalExpenses;

    return success({
      totalSales,
      totalExpenses,
      netProfit,
      transactionCount: transactions.length,
      topItems,
      dailySeries
    });
  } catch (err) {
    console.error("Error getting summary:", err);

    return error("Failed to get summary", 500);
  }
};