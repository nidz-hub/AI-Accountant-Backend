const {
  TextractClient,
  AnalyzeExpenseCommand
} = require("@aws-sdk/client-textract");

const {
  S3Client,
  GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
  PutCommand
} = require("@aws-sdk/lib-dynamodb");

const {
  createWorker
} = require("tesseract.js");

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
  invokeBedrock,
  invokeBedrockWithImage
} = require("../../shared/bedrockParse");

const {
  success,
  error
} = require("../../shared/response");

const textract = new TextractClient({});
const s3 = new S3Client({});

const BUCKET_NAME =
  process.env.UPLOAD_BUCKET;

let ocrWorkerPromise = null;


// =============================================================
// MAIN HANDLER
// =============================================================

exports.handler = async (event) => {
  try {
    // ---------------------------------------------------------
    // 1. Configuration
    // ---------------------------------------------------------

    if (!BUCKET_NAME) {
      console.error(
        "UPLOAD_BUCKET is not configured"
      );

      return error(
        "Upload storage is not configured",
        500
      );
    }

    if (!TABLE_NAME) {
      console.error(
        "TABLE_NAME is not configured"
      );

      return error(
        "Database is not configured",
        500
      );
    }

    // ---------------------------------------------------------
    // 2. Parse request
    // ---------------------------------------------------------

    let body;

    try {
      let rawBody =
        event.body || "{}";

      if (event.isBase64Encoded) {
        rawBody =
          Buffer.from(
            rawBody,
            "base64"
          ).toString("utf-8");
      }

      body =
        typeof rawBody === "string"
          ? JSON.parse(rawBody)
          : rawBody;

    } catch (parseError) {
      console.error(
        "Invalid request JSON:",
        parseError
      );

      return error(
        "Request body must be valid JSON",
        400
      );
    }

    const userId =
      body.userId;

    const s3Key =
      body.s3Key;

    // ---------------------------------------------------------
    // 3. Validate request
    // ---------------------------------------------------------

    if (
      userId !== "demo-user"
    ) {
      return error(
        "Invalid userId",
        400
      );
    }

    if (!s3Key) {
      return error(
        "s3Key is required",
        400
      );
    }

    const expectedPrefix =
      `uploads/${userId}/`;

    if (
      !s3Key.startsWith(
        expectedPrefix
      )
    ) {
      return error(
        "Invalid s3Key",
        400
      );
    }


    // =========================================================
    // PATH 1
    // TEXTRACT
    // =========================================================

    let textractText = "";

    try {
      console.log(
        "PATH 1: Starting Amazon Textract"
      );

      const response =
        await textract.send(
          new AnalyzeExpenseCommand({
            Document: {
              S3Object: {
                Bucket:
                  BUCKET_NAME,
                Name:
                  s3Key
              }
            }
          })
        );

      console.log(
        "Raw Textract response:",
        JSON.stringify(response)
      );

      const documents =
        response.ExpenseDocuments ||
        [];

      // -------------------------------------------------------
      // 1A. Direct structured Textract parsing
      // -------------------------------------------------------

      const directTransactions =
        buildTransactionsFromTextract(
          documents,
          userId
        );

      console.log(
        "Textract direct parser produced:",
        directTransactions.length
      );

      if (
        directTransactions.length > 0
      ) {
        const saved =
          await validateAndSaveTransactions(
            directTransactions
          );

        if (
          saved.length > 0
        ) {
          return success({
            transactions:
              saved
          });
        }
      }

      // -------------------------------------------------------
      // 1B. Textract text extraction
      // -------------------------------------------------------

      textractText =
        extractTextractText(
          response
        );

      console.log(
        "Textract extracted text:",
        textractText
      );

      // -------------------------------------------------------
      // 1C. Optional Bedrock text parser
      // -------------------------------------------------------

      if (
        textractText
      ) {
        try {
          console.log(
            "Trying Bedrock text parser after Textract"
          );

          const bedrockResponse =
            await invokeBedrock(
              buildParsingPrompt(
                textractText
              )
            );

          const parsed =
            extractTransactionsFromBedrock(
              bedrockResponse
            );

          const normalized =
            parsed.map(
              (transaction) =>
                normalizeTransaction({
                  ...transaction,

                  transactionId:
                    transaction.transactionId ||
                    crypto.randomUUID(),

                  userId,

                  source:
                    "photo",

                  rawInput:
                    textractText
                })
            );

          const saved =
            await validateAndSaveTransactions(
              normalized
            );

          if (
            saved.length > 0
          ) {
            return success({
              transactions:
                saved
            });
          }

        } catch (bedrockError) {
          console.error(
            "Bedrock text parsing unavailable:",
            bedrockError
          );
        }

        // -----------------------------------------------------
        // 1D. Local parser on Textract text
        // -----------------------------------------------------

        const localTransactions =
          parseInvoiceText(
            textractText,
            userId,
            75
          );

        if (
          localTransactions.length > 0
        ) {
          const saved =
            await validateAndSaveTransactions(
              localTransactions
            );

          if (
            saved.length > 0
          ) {
            return success({
              transactions:
                saved
            });
          }
        }
      }

    } catch (textractError) {
      console.error(
        "PATH 1 - Textract unavailable:",
        textractError
      );
    }


    // =========================================================
    // DOWNLOAD IMAGE
    // =========================================================

    let imageBuffer;

    try {
      console.log(
        "Downloading image from S3"
      );

      const imageObject =
        await s3.send(
          new GetObjectCommand({
            Bucket:
              BUCKET_NAME,
            Key:
              s3Key
          })
        );

      if (
        !imageObject.Body
      ) {
        throw new Error(
          "S3 returned no image body"
        );
      }

      imageBuffer =
        await streamToBuffer(
          imageObject.Body
        );

      if (
        !imageBuffer ||
        imageBuffer.length === 0
      ) {
        throw new Error(
          "Downloaded image is empty"
        );
      }

      console.log(
        "Image downloaded successfully:",
        imageBuffer.length,
        "bytes"
      );

    } catch (s3Error) {
      console.error(
        "Image download failed:",
        s3Error
      );

      return error(
        "Unable to read the uploaded receipt image",
        500
      );
    }


    // =========================================================
    // PATH 2
    // TESSERACT OCR + FLEXIBLE PARSER
    // =========================================================

    let tesseractText = "";

    try {
      console.log(
        "PATH 2: Starting Tesseract OCR"
      );

      const ocr =
        await runLocalOCR(
          imageBuffer
        );

      tesseractText =
        ocr.text;

      console.log(
        "Tesseract confidence:",
        ocr.confidence
      );

      console.log(
        "Tesseract OCR text:",
        tesseractText
      );

      // -------------------------------------------------------
      // 2A. Flexible line-item parser
      // -------------------------------------------------------

      const localTransactions =
        parseInvoiceText(
          tesseractText,
          userId,
          ocr.confidence
        );

      console.log(
        "Tesseract local parser produced:",
        localTransactions.length,
        "transactions"
      );

      if (
        localTransactions.length > 0
      ) {
        const saved =
          await validateAndSaveTransactions(
            localTransactions
          );

        if (
          saved.length > 0
        ) {
          return success({
            transactions:
              saved
          });
        }
      }

      // -------------------------------------------------------
      // 2B. Last-resort invoice-total parser
      // -------------------------------------------------------

      const invoiceFallback =
        createInvoiceTotalTransaction(
          tesseractText,
          userId,
          ocr.confidence
        );

      if (
        invoiceFallback
      ) {
        console.warn(
          "Using invoice-total fallback"
        );

        const saved =
          await validateAndSaveTransactions([
            invoiceFallback
          ]);

        if (
          saved.length > 0
        ) {
          return success({
            transactions:
              saved
          });
        }
      }

    } catch (ocrError) {
      console.error(
        "PATH 2 - Tesseract failed:",
        ocrError
      );
    }


    // =========================================================
    // PATH 3
    // BEDROCK VISION
    // =========================================================

    try {
      console.log(
        "PATH 3: Trying Bedrock Vision"
      );

      const bedrockResponse =
        await invokeBedrockWithImage(
          buildVisionPrompt(),
          imageBuffer.toString(
            "base64"
          ),
          getImageMediaType(
            s3Key
          )
        );

      console.log(
        "Raw Bedrock Vision response:",
        JSON.stringify(
          bedrockResponse
        )
      );

      const parsed =
        extractTransactionsFromBedrock(
          bedrockResponse
        );

      const normalized =
        parsed.map(
          (transaction) =>
            normalizeTransaction({
              ...transaction,

              transactionId:
                transaction.transactionId ||
                crypto.randomUUID(),

              userId,

              source:
                "photo",

              rawInput:
                tesseractText ||
                "Receipt processed using Bedrock Vision"
            })
        );

      const saved =
        await validateAndSaveTransactions(
          normalized
        );

      if (
        saved.length > 0
      ) {
        return success({
          transactions:
            saved
        });
      }

    } catch (visionError) {
      console.error(
        "PATH 3 - Bedrock Vision unavailable:",
        visionError
      );
    }


    // =========================================================
    // EVERYTHING FAILED
    // =========================================================

    return error(
      "Could not automatically read this receipt. Please enter the transaction manually.",
      422
    );

  } catch (err) {
    console.error(
      "processPhoto error:",
      err
    );

    return error(
      "Unable to process the uploaded photo",
      500
    );
  }
};


// =============================================================
// TESSERACT OCR
// =============================================================

async function runLocalOCR(
  imageBuffer
) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise =
      createWorker(
        "eng",
        1,
        {
          cachePath:
            "/tmp/tesseract"
        }
      );
  }

  const worker =
    await ocrWorkerPromise;

  await worker.setParameters({
    preserve_interword_spaces:
      "1",

    user_defined_dpi:
      "300"
  });

  const result =
    await worker.recognize(
      imageBuffer
    );

  return {
    text:
      String(
        result?.data?.text ||
          ""
      ).trim(),

    confidence:
      Number(
        result?.data?.confidence ||
          0
      )
  };
}


// =============================================================
// FLEXIBLE OCR INVOICE PARSER
// =============================================================

function parseInvoiceText(
  text,
  userId,
  ocrConfidence
) {
  const lines =
    String(
      text || ""
    )
      .split(
        /\r?\n/
      )
      .map(
        (line) =>
          line
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      )
      .filter(Boolean);

  const transactions = [];

  /*
   * Look for every visual/text row that contains a unit.
   *
   * We intentionally support OCR mistakes such as:
   * NOS -> N0S / NO5 / THOS / TWOS / MOS
   */
  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const unitMatch =
      findUnitInLine(
        lines[i]
      );

    if (!unitMatch) {
      continue;
    }

    /*
     * Stop before another unit-bearing row.
     * Everything between the current unit row and
     * the next unit row is considered part of this
     * invoice item.
     */
    const blockLines =
      [
        ...collectPreviousItemLines(
          lines,
          i
        ),

        lines[i],

        ...collectFollowingItemLines(
          lines,
          i
        )
      ];

    const parsed =
      parseInvoiceBlock(
        blockLines,
        lines[i],
        unitMatch,
        userId,
        ocrConfidence
      );

    if (
      parsed
    ) {
      transactions.push(
        parsed
      );
    }
  }

  return removeDuplicateTransactions(
    transactions
  );
}


// =============================================================
// PRECEDING ITEM LINES
// =============================================================

function collectPreviousItemLines(
  lines,
  index
) {
  const result = [];

  for (
    let i =
      index - 1;
    i >= 0 &&
    i >= index - 4;
    i--
  ) {
    const line =
      lines[i];

    if (
      findUnitInLine(
        line
      )
    ) {
      break;
    }

    if (
      looksLikeItemText(
        line
      )
    ) {
      result.unshift(
        line
      );

      /*
       * Usually the first good text line
       * immediately preceding the quantity
       * is enough.
       */
      if (
        result.length >= 2
      ) {
        break;
      }
    }
  }

  return result;
}


// =============================================================
// FOLLOWING NUMERIC LINES
// =============================================================

function collectFollowingItemLines(
  lines,
  index
) {
  const result = [];

  for (
    let i =
      index + 1;
    i < lines.length &&
    i <= index + 5;
    i++
  ) {
    if (
      findUnitInLine(
        lines[i]
      )
    ) {
      break;
    }

    /*
     * Numeric continuation lines are useful.
     * Stop at unrelated long textual paragraphs.
     */
    if (
      hasNumericContent(
        lines[i]
      )
    ) {
      result.push(
        lines[i]
      );

      continue;
    }

    /*
     * Short line containing a few words may still
     * be continuation of the table.
     */
    if (
      result.length > 0 &&
      lines[i].length < 40
    ) {
      result.push(
        lines[i]
      );
    } else {
      break;
    }
  }

  return result;
}


// =============================================================
// PARSE ONE INVOICE BLOCK
// =============================================================

function parseInvoiceBlock(
  blockLines,
  unitLine,
  unitMatch,
  userId,
  ocrConfidence
) {
  const unit =
    normalizeUnit(
      unitMatch.value
    );

  const quantity =
    findQuantityBeforeUnit(
      unitLine,
      unitMatch.index
    );

  /*
   * Everything after the unit on the unit line
   * plus all following numeric lines.
   */
  const unitStart =
    unitMatch.index +
    unitMatch.value.length;

  const currentTail =
    unitLine.slice(
      unitStart
    );

  const following =
    blockLines
      .slice(
        blockLines.indexOf(
          unitLine
        ) + 1
      )
      .join(" ");

  const numericText =
    `${currentTail} ${following}`;

  const numbers =
    extractMoneyValues(
      numericText
    );

  if (
    numbers.length < 2
  ) {
    return null;
  }

  const pricing =
    inferPricing(
      numbers,
      quantity
    );

  if (
    !pricing
  ) {
    return null;
  }

  const item =
    findItemFromBlock(
      blockLines,
      unitLine,
      unitMatch.index
    );

  if (
    !item ||
    isInvoiceHeading(
      item
    )
  ) {
    return null;
  }

  let confidence =
    Number(
      ocrConfidence
    ) / 100;

  if (
    !Number.isFinite(
      confidence
    )
  ) {
    confidence = 0.6;
  }

  confidence +=
    0.10;

  if (
    pricing.pricePerUnit >
    0
  ) {
    confidence +=
      0.05;
  }

  if (
    pricing.totalAmount >
    0
  ) {
    confidence +=
      0.05;
  }

  confidence =
    Math.max(
      0.5,
      Math.min(
        0.95,
        roundConfidence(
          confidence
        )
      )
    );

  return {
    transactionId:
      crypto.randomUUID(),

    userId,

    date:
      new Date().toISOString(),

    type:
      "purchase",

    item,

    quantity,

    unit,

    pricePerUnit:
      pricing.pricePerUnit,

    totalAmount:
      pricing.totalAmount,

    currency:
      "INR",

    counterparty:
      null,

    source:
      "photo",

    rawInput:
      blockLines.join(
        " | "
      ),

    confidence
  };
}


// =============================================================
// FIND UNIT
// =============================================================

function findUnitInLine(
  line
) {
  const match =
    String(
      line || ""
    ).match(
      /\b(NOS?|N0S?|NO5?|N05?|NDS|THOS|TWOS|TIOS|MOS|PCS?|PC|PIECES?|KG|KGS|GRAMS?|GRAM|G|LTR|LITRES?|LITERS?|LITRE|L|ML|BOXES?|BOX|BAGS?|BAG|PACKETS?|PACKET|PACKS?|PACK)\b/i
    );

  if (!match) {
    return null;
  }

  return {
    value:
      match[1],

    index:
      match.index
  };
}


// =============================================================
// FIND QUANTITY
// =============================================================

function findQuantityBeforeUnit(
  line,
  unitIndex
) {
  const before =
    line.slice(
      0,
      unitIndex
    );

  const matches =
    before.match(
      /\d+(?:[.,]\d+)?/g
    );

  if (
    !matches ||
    matches.length === 0
  ) {
    return 1;
  }

  /*
   * Prefer the final number before the unit.
   * This is normally the quantity.
   */
  const final =
    Number(
      matches[
        matches.length - 1
      ].replace(
        ",",
        "."
      )
    );

  /*
   * HSN/SAC/serial numbers can be large.
   */
  if (
    Number.isFinite(
      final
    ) &&
    final > 0 &&
    final < 1000
  ) {
    return final;
  }

  return 1;
}


// =============================================================
// FIND ITEM
// =============================================================

function findItemFromBlock(
  blockLines,
  unitLine,
  unitIndex
) {
  /*
   * First attempt:
   * text before the unit on the same line.
   */
  let sameLine =
    unitLine.slice(
      0,
      unitIndex
    );

  sameLine =
    removeLeadingNumbers(
      sameLine
    );

  sameLine =
    sameLine
      .replace(
        /[\[\]{}|_=~]+/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  /*
   * Remove final quantity.
   */
  sameLine =
    sameLine.replace(
      /\s+\d+(?:\.\d+)?\s*$/,
      ""
    ).trim();

  if (
    looksLikeItemText(
      sameLine
    ) &&
    !isInvoiceHeading(
      sameLine
    )
  ) {
    return cleanItem(
      sameLine
    );
  }

  /*
   * Search previous lines.
   *
   * This is the common case for:
   *
   * Bosch All-in-One Metal Hand Tool Kit
   * 8302
   * 1 NOS 2535...
   */
  for (
    let i =
      blockLines.length - 1;
    i >= 0;
    i--
  ) {
    const candidate =
      blockLines[i];

    if (
      candidate ===
      unitLine
    ) {
      continue;
    }

    if (
      !looksLikeItemText(
        candidate
      )
    ) {
      continue;
    }

    const cleaned =
      removeLeadingNumbers(
        candidate
      )
        .replace(
          /[\[\]{}|_=~]+/g,
          " "
        )
        .replace(
          /\s+/g,
          " "
        )
        .trim();

    if (
      cleaned.length >= 4 &&
      !isInvoiceHeading(
        cleaned
      )
    ) {
      return cleanItem(
        cleaned
      );
    }
  }

  return null;
}


// =============================================================
// DETERMINE IF A LINE LOOKS LIKE PRODUCT TEXT
// =============================================================

function looksLikeItemText(
  value
) {
  const text =
    String(
      value || ""
    ).trim();

  if (
    text.length < 4
  ) {
    return false;
  }

  if (
    isInvoiceHeading(
      text
    )
  ) {
    return false;
  }

  if (
    /^(?:tax|gst|cgst|sgst|igst|amount|total|subtotal|quantity|qty|rate|unit|description|hsn|sac|invoice|date|phone|email|bank|ifsc|terms|thank you)$/i.test(
      text
    )
  ) {
    return false;
  }

  /*
   * Product names normally contain alphabetic text.
   */
  return /[A-Za-z]{3,}/.test(
    text
  );
}


// =============================================================
// INFER PRICING
// =============================================================

function inferPricing(
  numbers,
  quantity
) {
  const values =
    numbers
      .filter(
        (value) =>
          Number.isFinite(
            value
          ) &&
          value > 0
      )
      .map(
        (value) =>
          roundMoney(
            value
          )
      );

  if (
    values.length < 2
  ) {
    return null;
  }

  const unique =
    [
      ...new Set(
        values
      )
    ];

  let best =
    null;

  for (
    const price
    of unique
  ) {
    if (
      price <= 0
    ) {
      continue;
    }

    const base =
      roundMoney(
        price *
          quantity
      );

    const repeated =
      values.filter(
        (value) =>
          Math.abs(
            value -
              price
          ) < 0.01
      ).length;

    const hasMatchingBase =
      values.some(
        (value) =>
          Math.abs(
            value -
              base
          ) <=
          Math.max(
            1,
            base *
              0.02
          )
      );

    /*
     * A total is usually the largest monetary value
     * in the line-item block.
     */
    const possibleTotals =
      unique.filter(
        (value) =>
          value >=
            base &&
          value <=
            base *
              1.75 +
            10
      );

    let total =
      null;

    if (
      possibleTotals.length > 0
    ) {
      total =
        Math.max(
          ...possibleTotals
        );
    }

    let score = 0;

    if (
      repeated >= 2
    ) {
      score += 5;
    }

    if (
      hasMatchingBase
    ) {
      score += 6;
    }

    if (
      total !== null
    ) {
      score += 4;
    }

    /*
     * Penalize obvious tax percentages.
     */
    if (
      price <= 50
    ) {
      score -= 4;
    }

    /*
     * Penalize long integer HSN-like values.
     */
    if (
      Number.isInteger(
        price
      ) &&
      price >= 1000 &&
      price <= 999999 &&
      !values.some(
        (value) =>
          value === price &&
          !Number.isInteger(
            value
          )
      )
    ) {
      /*
       * Only a small penalty; some legitimate unit prices
       * are large integers.
       */
      score -= 1;
    }

    if (
      !best ||
      score >
        best.score ||
      (
        score ===
          best.score &&
        price <
          best.price
      )
    ) {
      best = {
        price,
        total,
        score
      };
    }
  }

  if (
    !best ||
    best.price <= 0
  ) {
    return null;
  }

  const totalAmount =
    best.total !== null
      ? best.total
      : roundMoney(
          best.price *
            quantity
        );

  if (
    totalAmount <= 0
  ) {
    return null;
  }

  return {
    pricePerUnit:
      roundMoney(
        best.price
      ),

    totalAmount:
      roundMoney(
        totalAmount
      )
  };
}


// =============================================================
// INVOICE TOTAL FALLBACK
// =============================================================

function createInvoiceTotalTransaction(
  text,
  userId,
  ocrConfidence
) {
  const lines =
    String(
      text || ""
    )
      .split(
        /\r?\n/
      )
      .map(
        (line) =>
          line
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      )
      .filter(Boolean);

  /*
   * Search from the bottom because invoice totals
   * normally occur near the bottom.
   */
  for (
    let i =
      lines.length - 1;
    i >= 0;
    i--
  ) {
    const line =
      lines[i];

    if (
      !/(grand|total|amount|net|payable|invoice total|after tax)/i.test(
        line
      )
    ) {
      continue;
    }

    const numbers =
      extractMoneyValues(
        line
      );

    if (
      numbers.length === 0
    ) {
      continue;
    }

    const amount =
      Math.max(
        ...numbers
      );

    if (
      amount <= 0
    ) {
      continue;
    }

    let confidence =
      Number(
        ocrConfidence
      ) / 100;

    if (
      !Number.isFinite(
        confidence
      )
    ) {
      confidence =
        0.55;
    }

    confidence =
      Math.max(
        0.5,
        Math.min(
          0.75,
          roundConfidence(
            confidence
          )
        )
      );

    return {
      transactionId:
        crypto.randomUUID(),

      userId,

      date:
        new Date().toISOString(),

      type:
        "purchase",

      item:
        "Invoice purchase",

      quantity:
        1,

      unit:
        "invoice",

      pricePerUnit:
        roundMoney(
          amount
        ),

      totalAmount:
        roundMoney(
          amount
        ),

      currency:
        "INR",

      counterparty:
        null,

      source:
        "photo",

      rawInput:
        line,

      confidence
    };
  }

  return null;
}


// =============================================================
// TEXTRACT DIRECT PARSER
// =============================================================

function buildTransactionsFromTextract(
  documents,
  userId
) {
  const transactions =
    [];

  for (
    const document
    of documents
  ) {
    const summary =
      getSummaryObject(
        document
      );

    for (
      const group
      of document.LineItemGroups ||
      []
    ) {
      for (
        const lineItem
        of group.LineItems ||
        []
      ) {
        const fields =
          getLineItemFieldMap(
            lineItem
          );

        const item =
          firstValue(
            fields,
            [
              "ITEM",
              "DESCRIPTION",
              "EXPENSE_ROW_ITEM"
            ]
          );

        if (!item) {
          continue;
        }

        const quantityInfo =
          parseQuantity(
            firstValue(
              fields,
              [
                "QUANTITY",
                "QTY"
              ]
            )
          );

        const quantity =
          quantityInfo.quantity;

        const unit =
          quantityInfo.unit;

        let price =
          parseMoney(
            firstValue(
              fields,
              [
                "UNIT_PRICE",
                "RATE"
              ]
            )
          );

        let total =
          parseMoney(
            firstValue(
              fields,
              [
                "PRICE",
                "TOTAL",
                "AMOUNT"
              ]
            )
          );

        if (
          total === null &&
          price !== null
        ) {
          total =
            roundMoney(
              quantity *
                price
            );
        }

        if (
          price === null &&
          total !== null &&
          quantity > 0
        ) {
          price =
            roundMoney(
              total /
                quantity
            );
        }

        if (
          total === null
        ) {
          continue;
        }

        if (
          price === null
        ) {
          price = 0;
        }

        transactions.push({
          transactionId:
            crypto.randomUUID(),

          userId,

          date:
            parseDate(
              firstValue(
                summary,
                [
                  "INVOICE_RECEIPT_DATE",
                  "ORDER_DATE",
                  "DELIVERY_DATE"
                ]
              )
            ),

          type:
            detectTypeFromSummary(
              summary
            ),

          item:
            cleanItem(
              item
            ),

          quantity,

          unit,

          pricePerUnit:
            price,

          totalAmount:
            total,

          currency:
            "INR",

          counterparty:
            getCounterparty(
              summary
            ),

          source:
            "photo",

          rawInput:
            buildRawLineInput(
              fields
            ),

          confidence:
            getAverageFieldConfidence(
              fields
            )
        });
      }
    }
  }

  return removeDuplicateTransactions(
    transactions
  );
}


// =============================================================
// TEXTRACT TEXT
// =============================================================

function extractTextractText(
  response
) {
  const parts = [];

  for (
    const document
    of response.ExpenseDocuments ||
    []
  ) {
    for (
      const field
      of document.SummaryFields ||
      []
    ) {
      const label =
        field.Type?.Text ||
        "";

      const value =
        field.ValueDetection
          ?.Text ||
        "";

      if (
        label &&
        value
      ) {
        parts.push(
          `${label}: ${value}`
        );
      } else if (
        value
      ) {
        parts.push(
          value
        );
      }
    }

    for (
      const group
      of document.LineItemGroups ||
      []
    ) {
      for (
        const lineItem
        of group.LineItems ||
        []
    ) {
        const row = [];

        for (
          const field
          of lineItem
            .LineItemExpenseFields ||
            []
        ) {
          const label =
            field.Type?.Text ||
            "";

          const value =
            field.ValueDetection
              ?.Text ||
            "";

          if (
            label &&
            value
          ) {
            row.push(
              `${label}: ${value}`
            );
          } else if (
            value
          ) {
            row.push(
              value
            );
          }
        }

        if (
          row.length > 0
        ) {
          parts.push(
            row.join(
              " | "
            )
          );
        }
      }
    }
  }

  return parts.join(
    "\n"
  ).trim();
}


// =============================================================
// BEDROCK TEXT PROMPT
// =============================================================

function buildParsingPrompt(
  extractedText
) {
  return `
You are parsing an Indian business invoice into accounting transactions.

Return ONLY valid JSON.

Return an array:

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
- Supplier/vendor invoices normally mean purchase.
- Sales invoices normally mean sale.
- Rent/electricity/fuel/transport/wages normally mean expense.
- Extract each distinct line item.
- Calculate missing price or total when possible.
- Currency is INR.
- confidence must be between 0 and 1.
- Return JSON only.
- Do not return Markdown.

Invoice text:

${extractedText}
`;
}


// =============================================================
// BEDROCK VISION PROMPT
// =============================================================

function buildVisionPrompt() {
  return `
Extract transactions from this Indian business receipt/invoice image.

Return ONLY valid JSON.

Return:

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
- Extract every distinct line item.
- Supplier/vendor invoice => purchase.
- Sales invoice => sale.
- Business operating cost => expense.
- Calculate missing values where possible.
- Do not invent transactions.
- Currency must be INR.
- confidence must be between 0 and 1.
- Return JSON only.
`;
}


// =============================================================
// BEDROCK RESPONSE
// =============================================================

function extractTransactionsFromBedrock(
  response
) {
  const text =
    response?.content
      ?.find(
        (item) =>
          item.type ===
          "text"
      )
      ?.text ||
    "";

  if (!text) {
    throw new Error(
      "Bedrock returned no text"
    );
  }

  let cleaned =
    text
      .trim()
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  let parsed;

  try {
    parsed =
      JSON.parse(
        cleaned
      );
  } catch (_) {
    const start =
      cleaned.indexOf(
        "["
      );

    const end =
      cleaned.lastIndexOf(
        "]"
      );

    if (
      start === -1 ||
      end <= start
    ) {
      throw new Error(
        "Bedrock returned invalid JSON"
      );
    }

    parsed =
      JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );
  }

  if (
    Array.isArray(
      parsed
    )
  ) {
    return parsed;
  }

  if (
    parsed &&
    Array.isArray(
      parsed.transactions
    )
  ) {
    return parsed.transactions;
  }

  throw new Error(
    "Bedrock did not return a transaction array"
  );
}


// =============================================================
// VALIDATE + SAVE
// =============================================================

async function validateAndSaveTransactions(
  transactions
) {
  const saved = [];

  for (
    const transaction
    of transactions
  ) {
    const normalized =
      normalizeTransaction(
        transaction
      );

    const validation =
      validateTransaction(
        normalized
      );

    if (
      !validation.valid
    ) {
      console.warn(
        "Skipping invalid transaction:",
        validation.errors
      );

      continue;
    }

    await saveTransaction(
      normalized
    );

    saved.push(
      normalized
    );
  }

  return saved;
}


async function saveTransaction(
  transaction
) {
  await dynamoClient.send(
    new PutCommand({
      TableName:
        TABLE_NAME,

      Item:
        transaction
    })
  );
}


// =============================================================
// TEXTRACT HELPERS
// =============================================================

function getLineItemFieldMap(
  lineItem
) {
  const fields = {};

  for (
    const field
    of lineItem
      .LineItemExpenseFields ||
      []
  ) {
    const type =
      String(
        field.Type?.Text ||
          ""
      )
        .trim()
        .toUpperCase();

    const value =
      String(
        field.ValueDetection
          ?.Text ||
        field.LabelDetection
          ?.Text ||
        ""
      ).trim();

    if (
      type &&
      value
    ) {
      fields[type] = {
        value,

        confidence:
          Number(
            field.ValueDetection
              ?.Confidence ||
            field.LabelDetection
              ?.Confidence ||
            0
          )
      };
    }
  }

  return fields;
}


function getSummaryObject(
  document
) {
  const summary = {};

  for (
    const field
    of document.SummaryFields ||
    []
  ) {
    const type =
      String(
        field.Type?.Text ||
          ""
      )
        .trim()
        .toUpperCase();

    const value =
      String(
        field.ValueDetection
          ?.Text ||
        field.LabelDetection
          ?.Text ||
        ""
      ).trim();

    if (
      type &&
      value
    ) {
      summary[type] =
        value;
    }
  }

  return summary;
}


function firstValue(
  object,
  names
) {
  for (
    const name
    of names
  ) {
    if (
      object[name]?.value
    ) {
      return object[name]
        .value;
    }

    if (
      typeof object[name] ===
        "string" &&
      object[name]
    ) {
      return object[name];
    }
  }

  return null;
}


function getAverageFieldConfidence(
  fields
) {
  const values =
    Object.values(
      fields
    )
      .map(
        (field) =>
          Number(
            field.confidence
          )
      )
      .filter(
        (value) =>
          Number.isFinite(
            value
          ) &&
          value > 0
      );

  if (
    values.length === 0
  ) {
    return 0.8;
  }

  return Math.min(
    0.95,
    Math.max(
      0.5,
      roundConfidence(
        average(
          values
        ) / 100
      )
    )
  );
}


function parseQuantity(
  value
) {
  if (!value) {
    return {
      quantity:
        1,

      unit:
        "nos"
    };
  }

  const match =
    String(
      value
    ).match(
      /(\d+(?:[.,]\d+)?)\s*([A-Za-z]+)?/
    );

  if (!match) {
    return {
      quantity:
        1,

      unit:
        "nos"
    };
  }

  const quantity =
    Number(
      match[1].replace(
        ",",
        "."
      )
    );

  return {
    quantity:
      Number.isFinite(
        quantity
      ) &&
      quantity > 0
        ? quantity
        : 1,

    unit:
      normalizeUnit(
        match[2]
      )
  };
}


function detectTypeFromSummary(
  summary
) {
  if (
    summary.CUSTOMER_NAME ||
    summary.RECEIVER_NAME ||
    summary.BILL_TO_NAME
  ) {
    return "sale";
  }

  return "purchase";
}


function getCounterparty(
  summary
) {
  return (
    summary.VENDOR_NAME ||
    summary.RECEIVER_NAME ||
    summary.CUSTOMER_NAME ||
    null
  );
}


// =============================================================
// TEXT / IMAGE HELPERS
// =============================================================

function extractMoneyValues(
  value
) {
  const matches =
    String(
      value || ""
    ).match(
      /\d[\d,]*(?:\.\d{1,2})?/g
    ) || [];

  return matches
    .map(
      (entry) =>
        Number(
          entry.replace(
            /,/g,
            ""
          )
        )
    )
    .filter(
      (number) =>
        Number.isFinite(
          number
        )
    );
}


function parseMoney(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const match =
    String(
      value
    )
      .replace(
        /,/g,
        ""
      )
      .match(
        /-?\d+(?:\.\d+)?/
      );

  if (!match) {
    return null;
  }

  const number =
    Number(
      match[0]
    );

  return Number.isFinite(
    number
  )
    ? roundMoney(
        number
      )
    : null;
}


function normalizeUnit(
  value
) {
  const text =
    String(
      value || ""
    )
      .toLowerCase()
      .replace(
        /[^a-z0-9]/g,
        ""
      );

  const map = {
    no: "nos",
    nos: "nos",
    n0s: "nos",
    no5: "nos",
    n05: "nos",
    nds: "nos",
    thos: "nos",
    twos: "nos",
    tios: "nos",
    mos: "nos",

    pc: "piece",
    pcs: "piece",
    piece: "piece",
    pieces: "piece",

    kg: "kg",
    kgs: "kg",

    g: "g",
    gm: "g",
    gram: "g",
    grams: "g",

    l: "litre",
    ltr: "litre",
    litre: "litre",
    litres: "litre",
    liter: "litre",
    liters: "litre",

    ml: "ml",

    box: "box",
    boxes: "box",

    bag: "bag",
    bags: "bag",

    pack: "pack",
    packs: "pack",

    packet: "packet",
    packets: "packet"
  };

  return (
    map[text] ||
    text ||
    "nos"
  );
}


function removeLeadingNumbers(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /^\s*\d+\s+/,
      ""
    )
    .replace(
      /^\s*\d{3,8}\s+/,
      ""
    )
    .trim();
}


function cleanItem(
  value
) {
  return String(
    value ||
      "Unknown item"
  )
    .replace(
      /^[\s\-:|]+/,
      ""
    )
    .replace(
      /[\s\-:|]+$/,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function isInvoiceHeading(
  value
) {
  const text =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  return (
    text === "total" ||
    text === "subtotal" ||
    text === "amount" ||
    text === "tax" ||
    text === "rate" ||
    text === "price" ||
    text === "quantity" ||
    text === "description" ||
    text === "unit" ||
    text === "qty" ||
    text === "item" ||
    text === "hsn" ||
    text === "sac" ||
    text.includes(
      "total amount"
    ) ||
    text.includes(
      "taxable amount"
    ) ||
    text.includes(
      "name of product"
    )
  );
}


function hasNumericContent(
  value
) {
  return /\d/.test(
    String(
      value || ""
    )
  );
}


// =============================================================
// DUPLICATE REMOVAL
// =============================================================

function removeDuplicateTransactions(
  transactions
) {
  const seen =
    new Set();

  const result =
    [];

  for (
    const transaction
    of transactions
  ) {
    const key =
      [
        String(
          transaction.item ||
            ""
        )
          .toLowerCase()
          .replace(
            /\s+/g,
            " "
          ),

        transaction.quantity,

        transaction.unit,

        transaction.pricePerUnit,

        transaction.totalAmount
      ].join(
        "|"
      );

    if (
      seen.has(
        key
      )
    ) {
      continue;
    }

    seen.add(
      key
    );

    result.push(
      transaction
    );
  }

  return result;
}


// =============================================================
// IMAGE / S3
// =============================================================

async function streamToBuffer(
  stream
) {
  const chunks = [];

  for await (
    const chunk
    of stream
  ) {
    chunks.push(
      Buffer.from(
        chunk
      )
    );
  }

  return Buffer.concat(
    chunks
  );
}


function getImageMediaType(
  s3Key
) {
  const key =
    String(
      s3Key || ""
    ).toLowerCase();

  if (
    key.endsWith(
      ".png"
    )
  ) {
    return "image/png";
  }

  if (
    key.endsWith(
      ".webp"
    )
  ) {
    return "image/webp";
  }

  return "image/jpeg";
}


// =============================================================
// DATE
// =============================================================

function parseDate(
  value
) {
  if (!value) {
    return new Date()
      .toISOString();
  }

  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return new Date()
      .toISOString();
  }

  return date.toISOString();
}


// =============================================================
// NUMERIC HELPERS
// =============================================================

function roundMoney(
  value
) {
  return (
    Math.round(
      value * 100
    ) /
    100
  );
}


function roundConfidence(
  value
) {
  return (
    Math.round(
      value * 100
    ) /
    100
  );
}


function average(
  values
) {
  if (
    !values ||
    values.length === 0
  ) {
    return 0;
  }

  return (
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    values.length
  );
}


function buildRawLineInput(
  fields
) {
  return Object.entries(
    fields
  )
    .map(
      ([key, field]) =>
        `${key}: ${field.value}`
    )
    .join(
      " | "
    );
}