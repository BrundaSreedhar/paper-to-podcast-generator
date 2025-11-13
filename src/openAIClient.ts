// src/openaiClient.ts
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({path: 'env.config'});

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("OPENAI_API_KEY not found in environment");
}

export const openai = new OpenAI({ apiKey });