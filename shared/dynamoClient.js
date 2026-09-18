const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});

const dynamoClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

const TABLE_NAME = process.env.TABLE_NAME;

if (!TABLE_NAME) {
  console.warn("TABLE_NAME environment variable is not set");
}

module.exports = {
  dynamoClient,
  TABLE_NAME
};