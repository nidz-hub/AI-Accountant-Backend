const {
  QueryCommand
} = require("@aws-sdk/lib-dynamodb");

const {
  BedrockRuntimeClient,
  InvokeModelCommand
} = require("@aws-sdk/client-bedrock-runtime");

const {
  dynamoClient,
  TABLE_NAME
} = require("../../shared/dynamoClient");

const {
  success,
  error
} = require("../../shared/response");

const bedrock = new BedrockRuntimeClient({});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;

exports.handler = async (event) => {
  try {
    if (!TABLE_NAME) {
      console.error("TABLE_NAME is not configured");
      return error("Database is not configured", 500);
    }

    if (!MODEL_ID) {
      console.error("BEDROCK_MODEL_ID is not configured");
      return error("AI service is not configured", 500);
    }

    const userId =
      event.queryStringParameters?.userId;

    if (userId !== "demo-user") {
      return error("Invalid userId", 400);
    }

    /*
     * Get all transactions for this user.
     */
    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        }
      })
    );

    const transactions = result.Items || [];

    /*
     * Calculate months represented by the records.
     */
    const dates = transactions
      .map((transaction) => new Date(transaction.date))
      .filter((date) => !Number.isNaN(date.getTime()));

    let monthsOfRecords = 0;

    if (dates.length > 0) {
      const earliest = new Date(
        Math.min(...dates.map((date) => date.getTime()))
      );

      const latest = new Date(
        Math.max(...dates.map((date) => date.getTime()))
      );

      monthsOfRecords =
        (latest.getFullYear() - earliest.getFullYear()) * 12 +
        (latest.getMonth() - earliest.getMonth()) +
        1;
    }

    /*
     * Calculate record completeness.
     *
     * We check whether important accounting fields
     * are present in each transaction.
     */
    let completeRecords = 0;

    for (const transaction of transactions) {
      const requiredFields = [
        "date",
        "type",
        "item",
        "quantity",
        "unit",
        "pricePerUnit",
        "totalAmount",
        "currency"
      ];

      const complete = requiredFields.every(
        (field) =>
          transaction[field] !== undefined &&
          transaction[field] !== null &&
          transaction[field] !== ""
      );

      if (complete) {
        completeRecords++;
      }
    }

    const recordCompleteness =
      transactions.length === 0
        ? 0
        : Number(
            (completeRecords / transactions.length).toFixed(2)
          );

    /*
     * Deterministic readiness checklist.
     *
     * This is NOT a credit score and does not predict
     * loan approval.
     */
    const checklist = [
      {
        label: "3+ months of records",
        met: monthsOfRecords >= 3
      },
      {
        label: "At least 20 transactions",
        met: transactions.length >= 20
      },
      {
        label: "Records are mostly complete",
        met: recordCompleteness >= 0.8
      }
    ];

    const metCount =
      checklist.filter((item) => item.met).length;

    /*
     * Simple readiness score based only on record quality.
     * This is NOT a lender's credit score.
     */
    const score = Math.round(
      (metCount / checklist.length) * 100
    );

    /*
     * Ask Bedrock to turn the factual results
     * into a simple explanation for the user.
     */
    const prompt = `
You are explaining bookkeeping record readiness to a small-business owner.

This is NOT a credit score.
This is NOT a loan approval prediction.
This is NOT an underwriting decision.

Explain only what the business records currently show and what the owner could improve in their bookkeeping.

Use simple, encouraging language suitable for a small-business owner.

Facts:

Months of records: ${monthsOfRecords}
Number of transactions: ${transactions.length}
Record completeness: ${recordCompleteness}
Checklist:
${JSON.stringify(checklist)}

Write one short paragraph.
Do not mention internal AI systems.
Do not claim that a loan will be approved or rejected.
`;

    let narrative;

    try {
      narrative = await generateNarrative(prompt);
    } catch (bedrockError) {
      console.error(
        "Bedrock narrative generation failed:",
        bedrockError
      );

      narrative =
        buildFallbackNarrative(
          monthsOfRecords,
          transactions.length,
          recordCompleteness
        );
    }

    return success({
      score,
      monthsOfRecords,
      recordCompleteness,
      checklist,
      narrative
    });

  } catch (err) {
    console.error(
      "creditReadiness error:",
      err
    );

    return error(
      "Unable to calculate record readiness",
      500
    );
  }
};


async function generateNarrative(prompt) {
  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 300,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt
          }
        ]
      }
    ]
  };

  const command =
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(requestBody)
    });

  const response =
    await bedrock.send(command);

  const responseText =
    new TextDecoder().decode(response.body);

  console.log(
    "Raw Bedrock narrative response:",
    responseText
  );

  const parsed =
    JSON.parse(responseText);

  const text =
    parsed?.content
      ?.find((item) => item.type === "text")
      ?.text;

  if (!text) {
    throw new Error(
      "Bedrock returned no narrative"
    );
  }

  return text.trim();
}


function buildFallbackNarrative(
  monthsOfRecords,
  transactionCount,
  completeness
) {
  const percentage =
    Math.round(completeness * 100);

  return `Your records currently cover ${monthsOfRecords} month(s) with ${transactionCount} transaction(s), and about ${percentage}% of the records contain the main accounting details. Keeping regular and complete records can make your financial history easier to present when you apply for business financing.`;
}