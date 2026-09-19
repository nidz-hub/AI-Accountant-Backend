const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand
} = require("@aws-sdk/client-transcribe");

const {
  PutCommand
} = require("@aws-sdk/lib-dynamodb");

const crypto = require("crypto");

const {
  dynamoClient,
  TABLE_NAME
} = require("../../shared/dynamoClient");

const {
  validateTransaction,
  normalizeTransaction
} = require("../../shared/transactionSchema");

const {
  invokeBedrock
} = require("../../shared/bedrockParse");

const {
  success,
  error
} = require("../../shared/response");

const transcribe = new TranscribeClient({});

const LANGUAGE_CODE = "en-IN";

exports.handler = async (event) => {
  try {
    if (!TABLE_NAME) {
      console.error("TABLE_NAME is not configured");
      return error("Database is not configured", 500);
    }

    let body;

    try {
      let rawBody = event.body || "{}";

      if (event.isBase64Encoded) {
        rawBody = Buffer.from(rawBody, "base64").toString("utf-8");
      }

      body =
        typeof rawBody === "string"
          ? JSON.parse(rawBody)
          : rawBody;
    } catch (parseError) {
      console.error("Invalid request JSON:", parseError);
      return error("Request body must be valid JSON", 400);
    }

    const userId = body.userId;
    const s3Key = body.s3Key;

    if (userId !== "demo-user") {
      return error("Invalid userId", 400);
    }

    if (!s3Key) {
      return error("s3Key is required", 400);
    }

    const expectedPrefix = `uploads/${userId}/`;

    if (!s3Key.startsWith(expectedPrefix)) {
      return error("Invalid s3Key", 400);
    }

    const bucketName = process.env.UPLOAD_BUCKET;

    if (!bucketName) {
      console.error("UPLOAD_BUCKET is not configured");
      return error("Upload storage is not configured", 500);
    }

    console.log("Starting transcription:", {
      bucket: bucketName,
      s3Key
    });

    const jobName =
      `ai-accountant-${crypto.randomUUID()}`;

    const startCommand =
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,

        Media: {
          MediaFileUri:
            `s3://${bucketName}/${s3Key}`
        },

        MediaFormat: "webm",

        MediaSampleRateHertz: 48000,

        LanguageCode: LANGUAGE_CODE,

        OutputBucketName: bucketName
      });

    await transcribe.send(startCommand);

    console.log("Transcription job started:", jobName);

    const transcript =
      await waitForTranscription(jobName);

    console.log(
      "Transcription result:",
      transcript
    );

    if (!transcript) {
      return error(
        "Could not extract readable speech from the audio",
        422
      );
    }

    let parsedTransactions;

    try {
      const prompt =
        buildParsingPrompt(transcript);

      const bedrockResponse =
        await invokeBedrock(prompt);

      console.log(
        "Raw Bedrock parser response:",
        JSON.stringify(bedrockResponse)
      );

      parsedTransactions =
        extractTransactionsFromBedrock(
          bedrockResponse
        );

    } catch (bedrockError) {
      console.error(
        "Bedrock parsing failed:",
        bedrockError
      );

      parsedTransactions = [
        createFallbackTransaction(
          userId,
          transcript
        )
      ];
    }

    const savedTransactions = [];

    for (const transaction of parsedTransactions) {
      const normalized =
        normalizeTransaction({
          ...transaction,

          transactionId:
            transaction.transactionId ||
            crypto.randomUUID(),

          userId,

          source: "voice",

          rawInput: transcript
        });

      const validation =
        validateTransaction(normalized);

      if (!validation.valid) {
        console.warn(
          "Bedrock transaction failed validation:",
          {
            errors: validation.errors,
            transaction: normalized
          }
        );

        const fallback =
          createFallbackTransaction(
            userId,
            transcript
          );

        await saveTransaction(fallback);

        savedTransactions.push(fallback);

        continue;
      }

      await saveTransaction(normalized);

      savedTransactions.push(normalized);
    }

    return success({
      transactions: savedTransactions,
      transcript
    });

  } catch (err) {
    console.error(
      "processVoice error:",
      err
    );

    return error(
      "Unable to process the uploaded voice recording",
      500
    );
  }
};


async function waitForTranscription(jobName) {
  const maxAttempts = 30;
  const waitMilliseconds = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const command =
      new GetTranscriptionJobCommand({
        TranscriptionJobName: jobName
      });

    const response =
      await transcribe.send(command);

    const job =
      response.TranscriptionJob;

    const status =
      job?.TranscriptionJobStatus;

    console.log(
      `Transcription attempt ${attempt}: ${status}`
    );

    if (status === "COMPLETED") {
      const transcriptUri =
        job.Transcript?.TranscriptFileUri;

      if (!transcriptUri) {
        throw new Error(
          "Transcription completed without transcript URI"
        );
      }

      const transcriptResponse =
        await fetch(transcriptUri);

      if (!transcriptResponse.ok) {
        throw new Error(
          `Unable to download transcript: ${transcriptResponse.status}`
        );
      }

      const transcriptJson =
        await transcriptResponse.json();

      const text =
        transcriptJson?.results
          ?.transcripts?.[0]?.transcript || "";

      return text.trim();
    }

    if (status === "FAILED") {
      throw new Error(
        `Transcription failed: ${
          job?.FailureReason || "Unknown reason"
        }`
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, waitMilliseconds)
    );
  }

  throw new Error(
    "Transcription timed out"
  );
}


async function saveTransaction(transaction) {
  await dynamoClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: transaction
    })
  );
}


function buildParsingPrompt(transcript) {
  return `
You are parsing a spoken business transaction for a small-business accounting application.

Convert the spoken text into a JSON array of transactions.

Each transaction MUST follow this structure:

{
  "date": "ISO-8601 date",
  "type": "sale" | "expense" | "purchase",
  "item": "string",
  "quantity": number,
  "unit": "string",
  "pricePerUnit": number,
  "totalAmount": number,
  "currency": "INR",
  "counterparty": "string or null",
  "confidence": number
}

Rules:
- Return ONLY valid JSON.
- Return an array, even when there is only one transaction.
- Use INR unless another currency is clearly spoken.
- Use "purchase" for goods bought by the business.
- Use "expense" for business costs such as rent, electricity or transport.
- Use "sale" for goods or services sold by the business.
- If a field cannot be determined, make a reasonable best guess and reduce confidence.
- confidence must be between 0 and 1.
- Do not invent unnecessary transactions.
- totalAmount should represent the transaction total.
- pricePerUnit should represent the unit price when it can be determined.
- Interpret common Indian business speech naturally.
- Return JSON only.

Spoken transaction:

${transcript}
`;
}


function extractTransactionsFromBedrock(response) {
  const text =
    response?.content
      ?.find(
        (item) => item.type === "text"
      )
      ?.text || "";

  if (!text) {
    throw new Error(
      "Bedrock returned no text"
    );
  }

  const cleaned =
    text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch (parseError) {
    console.error(
      "Bedrock returned invalid JSON:",
      cleaned
    );

    throw parseError;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0
  ) {
    throw new Error(
      "Bedrock did not return a valid transaction array"
    );
  }

  return parsed;
}


function createFallbackTransaction(
  userId,
  rawText
) {
  return {
    transactionId:
      crypto.randomUUID(),

    userId,

    date:
      new Date().toISOString(),

    type: "expense",

    item: "Review voice transaction",

    quantity: 1,

    unit: "item",

    pricePerUnit: 0,

    totalAmount: 0,

    currency: "INR",

    counterparty: null,

    source: "voice",

    rawInput: rawText,

    confidence: 0
  };
}