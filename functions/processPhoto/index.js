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
  createWorker,
  PSM
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
    // 2. Request body
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
    // Textract -> direct structured extraction
    // =========================================================

    try {
      console.log(
        "PATH 1: Starting Amazon Textract AnalyzeExpense"
      );

      const textractResponse =
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
        JSON.stringify(
          textractResponse
        )
      );

      const documents =
        textractResponse.ExpenseDocuments ||
        [];

      const textractTransactions =
        buildTransactionsFromTextract(
          documents,
          userId
        );

      console.log(
        "Textract direct parser produced:",
        textractTransactions.length,
        "transactions"
      );

      if (
        textractTransactions.length > 0
      ) {
        const saved =
          await validateAndSaveTransactions(
            textractTransactions
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

      /*
       * Textract succeeded but structured line-item
       * parsing did not produce valid transactions.
       *
       * Try parsing the textual Textract representation.
       */

      const textractText =
        extractTextractText(
          textractResponse
        );

      if (textractText) {
        console.log(
          "Textract text fallback:",
          textractText
        );

        const textTransactions =
          parseInvoiceTextFromLines(
            textractText,
            userId,
            75
          );

        const saved =
          await validateAndSaveTransactions(
            textTransactions
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

    } catch (textractError) {
      /*
       * Important:
       * Textract can fail because the AWS account has
       * no service subscription. This should NOT kill
       * the request.
       */

      console.error(
        "PATH 1 - Textract unavailable/failed:",
        textractError
      );
    }


    // =========================================================
    // Download image
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
        "Image downloaded:",
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
    // Tesseract OCR -> geometry-aware local parser
    // =========================================================

    try {
      console.log(
        "PATH 2: Starting local Tesseract OCR"
      );

      const ocr =
        await runLocalOCR(
          imageBuffer
        );

      console.log(
        "Tesseract confidence:",
        ocr.confidence
      );

      console.log(
        "Tesseract text:",
        ocr.text
      );

      const localTransactions =
        parseInvoiceFromOCRData(
          ocr.data,
          userId,
          ocr.confidence
        );

      console.log(
        "Local OCR parser produced:",
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

    } catch (ocrError) {
      console.error(
        "PATH 2 - Local OCR failed:",
        ocrError
      );
    }


    // =========================================================
    // PATH 3
    // Bedrock Vision
    // =========================================================

    try {
      console.log(
        "PATH 3: Trying Bedrock Vision"
      );

      const response =
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
          response
        )
      );

      const parsed =
        extractTransactionsFromBedrock(
          response
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
        "PATH 3 - Bedrock Vision failed:",
        visionError
      );
    }


    // =========================================================
    // All paths failed
    // =========================================================

    console.error(
      "All photo-processing paths failed"
    );

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
      "300",

    tessedit_pageseg_mode:
      PSM.AUTO
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
      ),

    data:
      result?.data || {}
  };
}


// =============================================================
// GEOMETRY-AWARE OCR PARSER
// =============================================================

function parseInvoiceFromOCRData(
  data,
  userId,
  ocrConfidence
) {
  const rawWords =
    Array.isArray(
      data?.words
    )
      ? data.words
      : [];

  const words =
    rawWords
      .filter(
        (word) =>
          word &&
          String(
            word.text || ""
          ).trim()
      )
      .map(
        (word) => ({
          text:
            String(
              word.text
            ).trim(),

          confidence:
            Number(
              word.confidence ||
                0
            ),

          x0:
            Number(
              word.bbox?.x0 ??
                0
            ),

          y0:
            Number(
              word.bbox?.y0 ??
                0
            ),

          x1:
            Number(
              word.bbox?.x1 ??
                0
            ),

          y1:
            Number(
              word.bbox?.y1 ??
                0
            )
        })
      );

  if (
    words.length === 0
  ) {
    return [];
  }

  const rows =
    groupWordsIntoRows(
      words
    );

  const transactions = [];

  for (
    let rowIndex = 0;
    rowIndex < rows.length;
    rowIndex++
  ) {
    const currentRow =
      rows[rowIndex];

    const unitIndex =
      findUnitIndex(
        currentRow.words
      );

    if (
      unitIndex === -1
    ) {
      continue;
    }

    const unit =
      normalizeUnit(
        currentRow
          .words[
            unitIndex
          ].text
      );

    /*
     * Determine quantity from the words before the unit.
     */
    const quantity =
      findQuantity(
        currentRow.words,
        unitIndex
      );

    /*
     * Gather subsequent rows until the next
     * detected quantity/unit row.
     *
     * This handles OCR such as:
     *
     * Product name
     * HSN Qty Unit Rate Taxable Tax Total
     */
    const blockRows = [
      currentRow
    ];

    for (
      let j =
        rowIndex + 1;
      j <
        rows.length &&
      j <=
        rowIndex + 5;
      j++
    ) {
      if (
        findUnitIndex(
          rows[j].words
        ) !== -1
      ) {
        break;
      }

      blockRows.push(
        rows[j]
      );
    }

    const numericValues =
      collectNumericValues(
        blockRows
      );

    const pricing =
      inferPricing(
        numericValues,
        quantity
      );

    if (!pricing) {
      continue;
    }

    const item =
      findItemName(
        rows,
        rowIndex,
        unitIndex
      );

    if (
      !item ||
      isInvoiceHeading(
        item
      )
    ) {
      continue;
    }

    const wordConfidence =
      average(
        currentRow.words
          .map(
            (word) =>
              word.confidence
          )
          .filter(
            (value) =>
              Number.isFinite(
                value
              ) &&
              value > 0
          )
      );

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
        0.6;
    }

    if (
      wordConfidence > 0
    ) {
      confidence =
        Math.max(
          confidence,
          wordConfidence / 100
        );
    }

    confidence =
      Math.max(
        0.5,
        Math.min(
          0.95,
          roundConfidence(
            confidence + 0.08
          )
        )
      );

    transactions.push({
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
        blockRows
          .map(
            (row) =>
              row.text
          )
          .join(
            " | "
          ),

      confidence
    });
  }

  return removeDuplicateTransactions(
    transactions
  );
}


// =============================================================
// GROUP OCR WORDS INTO VISUAL ROWS
// =============================================================

function groupWordsIntoRows(
  words
) {
  const sorted =
    [...words].sort(
      (a, b) => {
        const ay =
          (a.y0 + a.y1) /
          2;

        const by =
          (b.y0 + b.y1) /
          2;

        if (
          Math.abs(
            ay - by
          ) > 8
        ) {
          return ay - by;
        }

        return a.x0 - b.x0;
      }
    );

  const rows = [];

  const yTolerance =
    14;

  for (
    const word
    of sorted
  ) {
    const centerY =
      (word.y0 + word.y1) /
      2;

    let matchingRow =
      null;

    for (
      let i =
        rows.length - 1;
      i >= 0;
      i--
    ) {
      if (
        Math.abs(
          rows[i].centerY -
            centerY
        ) <=
        yTolerance
      ) {
        matchingRow =
          rows[i];

        break;
      }

      /*
       * Rows are sorted vertically, so once we are
       * significantly above this word we can stop.
       */
      if (
        rows[i].centerY <
        centerY -
          yTolerance
      ) {
        break;
      }
    }

    if (
      !matchingRow
    ) {
      matchingRow = {
        centerY,
        words: []
      };

      rows.push(
        matchingRow
      );
    }

    matchingRow.words.push(
      word
    );

    matchingRow.centerY =
      average(
        matchingRow.words.map(
          (w) =>
            (w.y0 + w.y1) /
            2
        )
      );
  }

  rows.sort(
    (a, b) =>
      a.centerY -
      b.centerY
  );

  for (
    const row of rows
  ) {
    row.words.sort(
      (a, b) =>
        a.x0 - b.x0
    );

    row.text =
      row.words
        .map(
          (word) =>
            word.text
        )
        .join(" ");
  }

  return rows;
}


// =============================================================
// FIND INVOICE UNIT
// =============================================================

function findUnitIndex(
  words
) {
  for (
    let i = 0;
    i < words.length;
    i++
  ) {
    if (
      isUnit(
        words[i].text
      )
    ) {
      return i;
    }
  }

  return -1;
}


function isUnit(
  value
) {
  const text =
    String(
      value || ""
    )
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (
    [
      "NO",
      "NOS",
      "N0S",
      "NO5",
      "N05",
      "NDS",
      "THOS",
      "TWOS",
      "TIOS",
      "MOS"
    ].includes(
      text
    )
  ) {
    return true;
  }

  return [
    "PCS",
    "PC",
    "PIECE",
    "PIECES",
    "KG",
    "KGS",
    "G",
    "GM",
    "GRAM",
    "GRAMS",
    "L",
    "LTR",
    "LITRE",
    "LITRES",
    "LITER",
    "LITERS",
    "ML",
    "BOX",
    "BOXES",
    "BAG",
    "BAGS",
    "PACK",
    "PACKS",
    "PACKET",
    "PACKETS"
  ].includes(
    text
  );
}


// =============================================================
// NORMALIZE UNIT
// =============================================================

function normalizeUnit(
  value
) {
  const text =
    String(
      value || ""
    )
      .trim()
      .toLowerCase()
      .replace(
        /[^a-z0-9]/g,
        ""
      );

  const map = {
    no:
      "nos",

    nos:
      "nos",

    n0s:
      "nos",

    no5:
      "nos",

    n05:
      "nos",

    nds:
      "nos",

    thos:
      "nos",

    twos:
      "nos",

    tios:
      "nos",

    mos:
      "nos",

    pc:
      "piece",

    pcs:
      "piece",

    piece:
      "piece",

    pieces:
      "piece",

    kg:
      "kg",

    kgs:
      "kg",

    g:
      "g",

    gm:
      "g",

    gram:
      "g",

    grams:
      "g",

    l:
      "litre",

    ltr:
      "litre",

    litre:
      "litre",

    litres:
      "litre",

    liter:
      "litre",

    liters:
      "litre",

    ml:
      "ml",

    box:
      "box",

    boxes:
      "box",

    bag:
      "bag",

    bags:
      "bag",

    pack:
      "pack",

    packs:
      "pack",

    packet:
      "packet",

    packets:
      "packet"
  };

  return (
    map[text] ||
    text ||
    "nos"
  );
}


// =============================================================
// QUANTITY
// =============================================================

function findQuantity(
  words,
  unitIndex
) {
  /*
   * Look immediately before the unit first.
   */
  for (
    let i =
      unitIndex - 1;
    i >= 0;
    i--
  ) {
    const value =
      parseNumber(
        words[i].text
      );

    if (
      value !== null &&
      value > 0 &&
      value <= 100000
    ) {
      /*
       * Do not mistake a long HSN/SAC code for quantity.
       */
      if (
        Number.isInteger(
          value
        ) &&
        value >= 1000
      ) {
        continue;
      }

      return value;
    }
  }

  return 1;
}


// =============================================================
// COLLECT NUMERIC VALUES FROM OCR BLOCK
// =============================================================

function collectNumericValues(
  rows
) {
  const values = [];

  for (
    const row
    of rows
  ) {
    for (
      const word
      of row.words
    ) {
      const value =
        parseNumber(
          word.text
        );

      if (
        value === null ||
        value <= 0 ||
        value > 1000000
      ) {
        continue;
      }

      const raw =
        String(
          word.text
        ).trim();

      /*
       * Ignore obvious percentages such as 18
       * or 5 when they do not contain decimals.
       */
      if (
        value <= 50 &&
        !raw.includes(".") &&
        !/[₹$€£]/.test(
          raw
        )
      ) {
        continue;
      }

      values.push({
        value,
        raw,
        x0: word.x0,
        x1: word.x1,
        y:
          (word.y0 +
            word.y1) /
          2
      });
    }
  }

  return values;
}


// =============================================================
// INFER PRICE + TOTAL
// =============================================================

function inferPricing(
  values,
  quantity
) {
  if (
    !values ||
    values.length === 0
  ) {
    return null;
  }

  const numbers =
    values.map(
      (entry) =>
        roundMoney(
          entry.value
        )
    );

  const unique =
    [
      ...new Set(
        numbers
      )
    ];

  let best =
    null;

  /*
   * We are looking for a value which behaves like
   * a unit price and another value which behaves like
   * taxable amount / line total.
   */
  for (
    const price
    of unique
  ) {
    if (
      price <= 0
    ) {
      continue;
    }

    const baseAmount =
      price *
      quantity;

    /*
     * Values that approximately equal
     * quantity × unit price.
     */
    const matchingBase =
      unique.filter(
        (value) =>
          Math.abs(
            value -
              baseAmount
          ) <=
          Math.max(
            1,
            baseAmount *
              0.02
          )
      );

    /*
     * A tax-inclusive line total may be slightly
     * larger than the taxable/base amount.
     */
    const possibleTotals =
      unique
        .filter(
          (value) =>
            value >=
              baseAmount &&
            value <=
              baseAmount *
                1.6 +
              1
        )
        .sort(
          (a, b) =>
            a - b
        );

    let total =
      null;

    /*
     * For quantity 1, invoices commonly contain:
     *
     * 2535
     * 2535
     * 18
     * 456.30
     * 2991.30
     *
     * Choose the later larger plausible value.
     */
    if (
      possibleTotals.length
    ) {
      total =
        possibleTotals[
          possibleTotals.length -
            1
        ];
    }

    let score =
      0;

    /*
     * Repeated price values are strong evidence.
     */
    const repeatedCount =
      numbers.filter(
        (number) =>
          Math.abs(
            number -
              price
          ) <
          0.01
      ).length;

    if (
      repeatedCount >= 2
    ) {
      score += 5;
    }

    /*
     * Exact multiplication relationship.
     */
    if (
      matchingBase.length >
      0
    ) {
      score += 6;
    }

    /*
     * Plausible final total.
     */
    if (
      total !== null &&
      total >=
        baseAmount &&
      total <=
        baseAmount *
          1.6 +
          1
    ) {
      score += 5;
    }

    /*
     * Penalize likely HSN/SAC codes.
     */
    const isInteger =
      Number.isInteger(
        price
      );

    const hasDecimalRepresentation =
      values.some(
        (entry) =>
          Math.abs(
            entry.value -
              price
          ) <
          0.01 &&
          entry.raw.includes(
            "."
          )
      );

    if (
      isInteger &&
      price >= 1000 &&
      price <= 999999 &&
      !hasDecimalRepresentation
    ) {
      score -= 3;
    }

    /*
     * Prefer a smaller valid unit price when
     * the evidence is otherwise equal.
     */
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

  let totalAmount =
    best.total;

  if (
    totalAmount ===
    null
  ) {
    totalAmount =
      roundMoney(
        best.price *
          quantity
      );
  }

  /*
   * Ensure total isn't below the calculated base amount.
   */
  if (
    totalAmount <
    best.price *
      quantity
  ) {
    totalAmount =
      roundMoney(
        best.price *
          quantity
      );
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
// FIND ITEM NAME
// =============================================================

function findItemName(
  rows,
  rowIndex,
  unitIndex
) {
  const sameRowWords =
    rows[
      rowIndex
    ].words.slice(
      0,
      unitIndex
    );

  /*
   * If the product name and quantity are on the
   * same visual row, collect alphabetic words before
   * the unit.
   */
  const sameRowCandidates =
    sameRowWords
      .map(
        (word) =>
          word.text
      )
      .filter(
        (text) =>
          /[A-Za-z]{2,}/.test(
            text
          ) &&
          !isTechnicalToken(
            text
          )
      );

  const sameRowItem =
    cleanItem(
      sameRowCandidates.join(
        " "
      )
    );

  if (
    sameRowItem &&
    !isInvoiceHeading(
      sameRowItem
    )
  ) {
    return sameRowItem;
  }

  /*
   * Otherwise search preceding rows.
   *
   * This is important for invoices where OCR gives:
   *
   * Bosch All-in-One Metal Hand Tool Kit
   * 8302 1 NOS 2535...
   */
  for (
    let i =
      rowIndex - 1;
    i >=
      Math.max(
        0,
        rowIndex - 4
      );
    i--
  ) {
    const candidate =
      rows[i].words
        .map(
          (word) =>
            word.text
        )
        .filter(
          (text) =>
            /[A-Za-z]{2,}/.test(
              text
            )
        )
        .join(
          " "
        );

    const cleaned =
      cleanItem(
        candidate
      );

    if (
      cleaned.length >= 4 &&
      !isInvoiceHeading(
        cleaned
      ) &&
      !isTechnicalTokenLine(
        cleaned
      )
    ) {
      return cleaned;
    }
  }

  return null;
}


// =============================================================
// CLEAN ITEM
// =============================================================

function cleanItem(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /^\d+\s+/,
      ""
    )
    .replace(
      /^\d{3,8}\s+/,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


// =============================================================
// HEADINGS / TECHNICAL TOKENS
// =============================================================

function isTechnicalToken(
  value
) {
  return /^(?:HSN|SAC|QTY|QUANTITY|UNIT|RATE|PRICE|AMOUNT|TOTAL|TAX|GST|CGST|SGST|IGST|DESCRIPTION|VALUE|NOS?|PCS?)$/i.test(
    String(
      value || ""
    )
      .replace(
        /[:.,-]/g,
        ""
      )
      .trim()
  );
}


function isTechnicalTokenLine(
  value
) {
  return /^(?:HSN|SAC|QTY|QUANTITY|UNIT|RATE|PRICE|AMOUNT|TOTAL|TAX|GST|CGST|SGST|IGST|DESCRIPTION|VALUE)(?:\s+(?:HSN|SAC|QTY|QUANTITY|UNIT|RATE|PRICE|AMOUNT|TOTAL|TAX|GST|CGST|SGST|IGST|DESCRIPTION|VALUE))*$/i.test(
    String(
      value || ""
    )
      .trim()
  );
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
    text ===
      "total" ||
    text ===
      "subtotal" ||
    text ===
      "tax" ||
    text ===
      "rate" ||
    text ===
      "amount" ||
    text ===
      "quantity" ||
    text ===
      "description" ||
    text.includes(
      "name of product"
    ) ||
    text.includes(
      "taxable amount"
    ) ||
    text.includes(
      "total amount"
    ) ||
    (
      text.includes(
        "invoice"
      ) &&
      text.length <
        40
    )
  );
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
      !type ||
      !value
    ) {
      continue;
    }

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
          row.length
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
// TEXTRACT TEXT FALLBACK
// =============================================================

function parseInvoiceTextFromLines(
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

  const transactions =
    [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const block =
      lines
        .slice(
          Math.max(
            0,
            i - 2
          ),
          Math.min(
            lines.length,
            i + 5
          )
        )
        .join(
          " "
        );

    const parsed =
      parseLooseInvoiceBlock(
        block
      );

    if (!parsed) {
      continue;
    }

    transactions.push({
      transactionId:
        crypto.randomUUID(),

      userId,

      date:
        new Date().toISOString(),

      type:
        "purchase",

      item:
        parsed.item,

      quantity:
        parsed.quantity,

      unit:
        parsed.unit,

      pricePerUnit:
        parsed.pricePerUnit,

      totalAmount:
        parsed.totalAmount,

      currency:
        "INR",

      counterparty:
        null,

      source:
        "photo",

      rawInput:
        block,

      confidence:
        Math.max(
          0.5,
          Math.min(
            0.9,
            Number(
              ocrConfidence ||
                60
            ) / 100
          )
        )
    });
  }

  return removeDuplicateTransactions(
    transactions
  );
}


function parseLooseInvoiceBlock(
  text
) {
  const unitMatch =
    String(
      text || ""
    ).match(
      /\b(NOS?|N0S?|NO5?|N05?|NDS|THOS|TWOS|TIOS|MOS|PCS?|PIECES?|KG|KGS|GRAMS?|G|LITRES?|LITERS?|LTR|ML|BOXES?|BAGS?|PACKS?|PACKETS?)\b/i
    );

  if (
    !unitMatch
  ) {
    return null;
  }

  const before =
    text.slice(
      0,
      unitMatch.index
    );

  const quantityMatch =
    before.match(
      /(\d+(?:\.\d+)?)\s*$/
    );

  const quantity =
    quantityMatch
      ? Number(
          quantityMatch[1]
        )
      : 1;

  const item =
    cleanItem(
      before.replace(
        quantityMatch
          ? quantityMatch[0]
          : "",
        ""
      )
    );

  const numbers =
    extractMoneyValues(
      text.slice(
        (
          unitMatch.index ||
          0
        ) +
          unitMatch[0].length
      )
    );

  const pricing =
    inferPricing(
      numbers.map(
        (value) => ({
          value,
          raw:
            String(
              value
            )
        })
      ),
      quantity
    );

  if (
    !item ||
    !pricing
  ) {
    return null;
  }

  return {
    item,

    quantity,

    unit:
      normalizeUnit(
        unitMatch[0]
      ),

    pricePerUnit:
      pricing.pricePerUnit,

    totalAmount:
      pricing.totalAmount
  };
}


// =============================================================
// BEDROCK VISION
// =============================================================

function buildVisionPrompt() {
  return `
You are extracting accounting transactions from an Indian business receipt or invoice.

Return ONLY valid JSON.

Return an array of objects with:

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
- Extract every distinct line item.
- Use INR.
- Supplier/vendor invoices should normally be "purchase".
- Sales invoices should normally be "sale".
- Business costs such as rent, electricity, fuel and transport should be "expense".
- Read quantities and prices carefully.
- Calculate missing values where possible.
- Do not invent transactions.
- confidence must be between 0 and 1.
- Return JSON only.
`;
}


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
// SAVE / VALIDATE
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
        validation.errors,
        normalized
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
// COUNTERPARTY / TYPE / DATE
// =============================================================

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
// QUANTITY / MONEY
// =============================================================

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


function parseMoney(
  value
) {
  if (
    value ===
      null ||
    value ===
      undefined
  ) {
    return null;
  }

  const cleaned =
    String(
      value
    )
      .replace(
        /,/g,
        ""
      )
      .replace(
        /₹/g,
        ""
      )
      .replace(
        /Rs\.?/gi,
        ""
      )
      .replace(
        /INR/gi,
        ""
      );

  const match =
    cleaned.match(
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


function parseNumber(
  value
) {
  const text =
    String(
      value || ""
    )
      .trim()
      .replace(
        /,/g,
        ""
      );

  if (
    !/^\d+(?:\.\d+)?$/.test(
      text
    )
  ) {
    return null;
  }

  const number =
    Number(
      text
    );

  return Number.isFinite(
    number
  )
    ? number
    : null;
}


// =============================================================
// RAW INPUT / IMAGE
// =============================================================

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


async function streamToBuffer(
  stream
) {
  const chunks = [];

  for await (
    const chunk of stream
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
        ).toLowerCase(),

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
// MATH HELPERS
// =============================================================

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