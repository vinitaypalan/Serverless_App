const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const AWS = require("aws-sdk");
const AmazonDaxClient = require("amazon-dax-client");

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const daxEndpoint = process.env.DAX_ENDPOINT;
const daxDocumentClient = daxEndpoint
  ? new AWS.DynamoDB.DocumentClient({
      service: new AmazonDaxClient({
        endpoints: [daxEndpoint],
        region: process.env.AWS_REGION,
      }),
    })
  : null;

exports.handler = async (event) => {
  if (event?.httpMethod === "GET") {
    const orderId = event.pathParameters?.orderId;

    if (typeof orderId !== "string" || !orderId.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "orderId is required" }),
      };
    }

    if (!daxDocumentClient) {
      throw new Error("DAX_ENDPOINT is required for order reads");
    }

    const result = await daxDocumentClient
      .query({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: "orderId = :orderId",
        ExpressionAttributeValues: {
          ":orderId": orderId,
        },
      })
      .promise();

    return {
      statusCode: 200,
      body: JSON.stringify({
        count: result.Count,
        items: result.Items ?? [],
      }),
    };
  }

  let order;

  try {
    order =
      typeof event?.body === "string"
        ? JSON.parse(event.body)
        : event?.body ?? event;
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Request body must be valid JSON" }),
    };
  }

  if (
    !order ||
    typeof order !== "object" ||
    Array.isArray(order) ||
    typeof order.orderId !== "string" ||
    !order.orderId.trim() ||
    typeof order.itemId !== "string" ||
    !order.itemId.trim()
  ) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "orderId and itemId are required non-empty strings",
      }),
    };
  }

  await dynamoDb.send(
    new PutCommand({
      TableName: process.env.TABLE_NAME,
      Item: order,
    }),
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      message: "Order saved",
      orderId: order.orderId,
      itemId: order.itemId,
    }),
  };
};
