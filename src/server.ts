// src/server.ts
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import { extractTextFromPdf } from "./services/PDFService";
import { generateScriptAndKeyPoints } from "./services/LLMService";
import { synthesizeSpeech } from "./services/AudioService";
import dotenv from "dotenv";

dotenv.config({path: 'env.config'});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public"))); // serve public (index.html + audio)

const upload = multer({ dest: "uploads/" });

app.post("/api/generate", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
    const filePath = req.file.path;

    // Extract text
    const text = await extractTextFromPdf(filePath);
    if (!text || text.trim().length < 50) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Could not extract text from PDF" });
    }

    // LLM: script + keypoints
    const { summary, keyPoints, script } = await generateScriptAndKeyPoints(text, 10);

    // TTS
    let audioUrl: string | null = null;
    try {
      audioUrl = await synthesizeSpeech(script, path.parse(req.file.originalname).name);
    } catch (e: any) {
      console.error("TTS failed:", e);
      // continue returning transcript and keypoints but mark audio null
    }

    // cleanup uploaded file
    fs.unlinkSync(filePath);

    return res.json({
      summary,
      keyPoints,
      script,
      audioUrl: audioUrl ? `/audio/${audioUrl.split("/").pop()}` : null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(Number(PORT), () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});