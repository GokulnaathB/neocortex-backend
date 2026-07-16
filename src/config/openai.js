import OpenAI from "openai";

export const AIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
