import express from "express";
import { Webhook } from "svix";
import { db } from "../index.js";
import { chatSessions } from "../db/schema.js";
import { client as qdrantClient } from "../config/qdrant.js";

const router = express.Router();

router.post(
  "/clerk",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET);

    let event;
    try {
      event = wh.verify(req.body, {
        "svix-id": req.headers["svix-id"],
        "svix-timestamp": req.headers["svix-timestamp"],
        "svix-signature": req.headers["svix-signature"],
      });
    } catch (err) {
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    const existingUsers = await db.select().from(chatSessions).limit(1);

    if (event.type === "user.created") {
      const userId = event.data.id;
      await db.insert(chatSessions).values({
        userId,
        title: "Your first convo",
      });
      // console.log("Created first session for user:", userId);
    }

    if (existingUsers.length === 0) {
      await qdrantClient.createCollection("pdf-chunks", {
        vectors: {
          size: 1536,
          distance: "Cosine",
        },
      });

      await qdrantClient.createPayloadIndex("pdf-chunks", {
        field_name: "metadata.userId",
        field_schema: "keyword",
      });

      await qdrantClient.createPayloadIndex("pdf-chunks", {
        field_name: "metadata.documentId",
        field_schema: "keyword",
      });

      // console.log("Collection and indexes created.");
    }

    return res.json({ received: true });
  },
);

export default router;
