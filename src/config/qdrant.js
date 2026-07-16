import { QdrantClient } from "@qdrant/js-client-rest";

// Connecting to my existing Qdrant collection
export const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
}); // connection object.
