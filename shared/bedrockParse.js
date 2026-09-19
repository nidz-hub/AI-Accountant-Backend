const {
  BedrockRuntimeClient,
  InvokeModelCommand
} = require("@aws-sdk/client-bedrock-runtime");

const client = new BedrockRuntimeClient({});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;

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

  return JSON.parse(responseText);
}

async function invokeBedrockWithImage(prompt, imageBase64, mediaType) {
  if (!MODEL_ID) {
    throw new Error("BEDROCK_MODEL_ID environment variable is not set");
  }

  if (!imageBase64) {
    throw new Error("Image data is required");
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
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBase64
            }
          },
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

  console.log("Raw Bedrock image response:", responseText);

  return JSON.parse(responseText);
}

module.exports = {
  invokeBedrock,
  invokeBedrockWithImage
};