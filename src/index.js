const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
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
