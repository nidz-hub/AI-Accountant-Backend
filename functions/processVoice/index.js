const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand
} = require("@aws-sdk/client-transcribe");

const {
  S3Client,
  GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
  DynamoDBClient,
  PutItemCommand
} = require("@aws-sdk/client-dynamodb");

const crypto = require("crypto");

const { invokeBedrock } = require("../../shared/bedrockParse");
const {
  validateTransaction,
  normalizeTransaction
} = require("../../shared/transactionSchema");
const { success, error } = require("../../shared/response");

const transcribe = new TranscribeClient({});
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

const BUCKET_NAME = process.env.UPLOAD_BUCKET;
const TABLE_NAME = process.env.TABLE_NAME;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function createFallbackTransaction(userId, transcript) {
  const now = new Date().toISOString();

  return {
    transactionId: crypto.randomUUID(),
    userId,
    date: now,
    type: "expense",
    item: "Review voice entry",
    quantity: 1,
    unit: "entry",
    pricePerUnit: 0,
    totalAmount: 0,
    currency: "INR",
    counterparty: null,
    source: "voice",
    rawInput: transcript,
    confidence: 0
  };
}

function buildPrompt(transcript) {
  return `
You are parsing a voice transaction for a small informal Indian business.

Convert the transcript into one or more transactions.

Return ONLY valid JSON in this exact format:

[
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
]

Rules:
- Use INR.
- "bought", "purchased", "paid for" usually means purchase or expense.
- "sold", "sale", "received from customer" usually means sale.
- Calculate totalAmount when quantity and pricePerUnit are available.
- If information is missing, make a reasonable best effort.
- confidence must be between 0 and 1.
- Do not include markdown.
- Do not include explanations.

Transcript:
${transcript}
`;
}

async function parseTranscriptWithBedrock(transcript) {
  const prompt = buildPrompt(transcript);

  console.log("Sending transcript to Bedrock:", transcript);

  const response = await invokeBedrock(prompt);

  console.log("Raw Bedrock response:", JSON.stringify(response));

  const text = response?.content?.[0]?.text;

  if (!text) {
    throw new Error("Bedrock returned no text");
  }

  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Bedrock response is not an array");
  }

  return parsed;
}

async function saveTransaction(transaction) {
  const normalized = normalizeTransaction(transaction);

  const validation = validateTransaction(normalized);

  if (!validation.valid) {
    throw new Error(
      `Invalid transaction: ${validation.errors.join(", ")}`
    );
  }

  await dynamodb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: { S: normalized.userId },
        transactionId: { S: normalized.transactionId },
        date: { S: normalized.date },
        type: { S: normalized.type },
        item: { S: normalized.item },
        quantity: { N: String(normalized.quantity) },
        unit: { S: normalized.unit },
        pricePerUnit: { N: String(normalized.pricePerUnit) },
        totalAmount: { N: String(normalized.totalAmount) },
        currency: { S: normalized.currency },
        counterparty: {
          S: normalized.counterparty || ""
        },
        source: { S: normalized.source },
        rawInput: { S: normalized.rawInput },
        confidence: { N: String(normalized.confidence) }
      }
    })
  );

  return normalized;
}

async function transcribeFromS3(s3Key) {
  const jobName = `voice-${crypto.randomUUID()}`;

  console.log("Starting transcription:", {
    bucket: BUCKET_NAME,
    s3Key
  });

  await transcribe.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: {
        MediaFileUri: `s3://${BUCKET_NAME}/${s3Key}`
      },
      MediaFormat: "webm",
      MediaSampleRateHertz: 48000,
      LanguageCode: "en-IN",
      OutputBucketName: BUCKET_NAME
    })
  );

  let transcriptUri;

  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(2000);

    const result = await transcribe.send(
      new GetTranscriptionJobCommand({
        TranscriptionJobName: jobName
      })
    );

    const job = result.TranscriptionJob;

    console.log("Transcription status:", job?.TranscriptionJobStatus);

    if (job?.TranscriptionJobStatus === "COMPLETED") {
      transcriptUri = job.Transcript?.TranscriptFileUri;
      break;
    }

    if (job?.TranscriptionJobStatus === "FAILED") {
      throw new Error(
        job.FailureReason || "Transcription job failed"
      );
    }
  }

  if (!transcriptUri) {
    throw new Error("Transcription timed out");
  }

  console.log("Transcript URI:", transcriptUri);

  const url = new URL(transcriptUri);

  const bucket = url.hostname.split(".")[0];
  const key = decodeURIComponent(
    url.pathname.replace(/^\/+/, "")
  );

  const transcriptObject = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  const transcriptJson = JSON.parse(
    await streamToString(transcriptObject.Body)
  );

  const transcript =
    transcriptJson?.results?.transcripts?.[0]?.transcript;

  if (!transcript) {
    throw new Error("Transcript text was empty");
  }

  return transcript;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const userId = body.userId;
    const s3Key = body.s3Key;
    const suppliedTranscript = body.transcript;

    if (userId !== "demo-user") {
      return error("Invalid userId", 400);
    }

    /*
     * FALLBACK PATH
     *
     * If the browser already supplied a transcript,
     * we do NOT call AWS Transcribe.
     */
    let transcript;

    if (
      typeof suppliedTranscript === "string" &&
      suppliedTranscript.trim()
    ) {
      transcript = suppliedTranscript.trim();

      console.log("Using supplied browser transcript");
    } else {
      /*
       * ORIGINAL AWS TRANSCRIBE PATH
       */
      if (!s3Key) {
        return error(
          "Either transcript or s3Key is required",
          400
        );
      }

      if (!s3Key.startsWith(`uploads/${userId}/`)) {
        return error("Invalid s3Key", 400);
      }

      transcript = await transcribeFromS3(s3Key);
    }

    console.log("Final transcript:", transcript);

    let parsedTransactions;

    try {
      parsedTransactions = await parseTranscriptWithBedrock(
        transcript
      );
    } catch (bedrockError) {
      console.error(
        "Bedrock parsing failed:",
        bedrockError
      );

      const fallback = createFallbackTransaction(
        userId,
        transcript
      );

      const saved = await saveTransaction(fallback);

      return success({
        transactions: [saved],
        transcript
      });
    }

    const transactions = [];

    for (const parsed of parsedTransactions) {
      const transaction = normalizeTransaction({
        ...parsed,
        transactionId: crypto.randomUUID(),
        userId,
        source: "voice",
        rawInput: transcript
      });

      const validation = validateTransaction(transaction);

      if (!validation.valid) {
        console.error(
          "Invalid Bedrock transaction:",
          validation.errors
        );

        const fallback = createFallbackTransaction(
          userId,
          transcript
        );

        const saved = await saveTransaction(fallback);

        transactions.push(saved);
        continue;
      }

      const saved = await saveTransaction(transaction);

      transactions.push(saved);
    }

    return success({
      transactions,
      transcript
    });
  } catch (err) {
    console.error("processVoice error:", err);

    return error(
      "Unable to process the uploaded voice recording",
      500
    );
  }
};