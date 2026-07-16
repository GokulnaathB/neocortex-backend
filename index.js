import "dotenv/config";
import express from "express";
import cors from "cors";
import { clerkMiddleware, getAuth } from "@clerk/express";

import webhooksRouter from "./src/routes/webhooks.js";
import uploadRouter from "./src/routes/upload.js";
import chatRouter from "./src/routes/chat.js";
import sessionsRouter from "./src/routes/sessions.js";

const app = express();
app.use(cors());

app.use("/webhooks", webhooksRouter);
app.use(express.json());

app.use(clerkMiddleware({ secretKey: process.env.CLERK_SECRET_KEY })); // clerkMiddleware attaches auth info to the req object.

app.get("/", (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ status: "All Good!" });
});

app.use("/upload", uploadRouter);
app.use("/chat", chatRouter);
app.use("/sessions", sessionsRouter);

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => console.log(`Server started on PORT:${PORT}`));
