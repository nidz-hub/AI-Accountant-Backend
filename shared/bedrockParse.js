const {
  BedrockRuntimeClient,
  InvokeModelCommand
} = require("@aws-sdk/client-bedrock-runtime");

const client = new BedrockRuntimeClient({});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;

/**
 * Send text to Amazon Bedrock and return the raw model response.
 *
 * The prompt itself will be supplied by the caller.
 * This keeps the Bedrock wrapper separate from the business logic.
 */
async function invokeBedrock(prompt) {
  if (!MODEL_ID) {
    throw new Error("BEDROCK_MODEL_ID environment variable is not set");
  }

  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1000,
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

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(requestBody)
  });

  const response = await client.send(command);

  const responseText = new TextDecoder().decode(response.body);

  console.log("Raw Bedrock response:", responseText);

  const parsedResponse = JSON.parse(responseText);

  return parsedResponse;
}

module.exports = {
  invokeBedrock
};