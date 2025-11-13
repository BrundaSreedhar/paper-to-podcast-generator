import fs from "fs";
import path from "path";
import {openai} from "../openAIClient";
import { v4 as uuidv4 } from "uuid";

const AUDIO_DIR = path.join(process.cwd(), "public", "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

export async function synthesizeSpeech(text: string, filenamePrefix = "podcast"): Promise<string> {
  // create unique file name
  const fname = `${filenamePrefix}_${Date.now()}_${uuidv4()}.mp3`;
  const outPath = path.join(AUDIO_DIR, fname);

  // The OpenAI JS SDK audio speech API sometimes returns a stream or ArrayBuffer.
  // Use the audio.speech.create endpoint. Adjust model and voice to your account.
  const res = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts", // or a TTS model available in your account
    voice: "alloy",
    input: text
  });

  // The response might be a Node.js Readable stream or a Blob-like object.
  // The modern SDK returns a Response-like object with arrayBuffer() in some setups.
  // Try multiple ways to persist the response:

  // If res is a web Response with arrayBuffer()
  if (typeof (res as any).arrayBuffer === "function") {
    const buffer = Buffer.from(await (res as any).arrayBuffer());
    fs.writeFileSync(outPath, buffer);
    return `/audio/${fname}`;
  }

  // If res is readable stream (Node)
  if (res instanceof Buffer) {
    fs.writeFileSync(outPath, res);
    return `/audio/${fname}`;
  }

  // Some SDKs provide .stream() or .pipe; attempt to handle generic Node stream
  if ((res as any).stream && typeof (res as any).stream.pipe === "function") {
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      (res as any).stream.pipe(ws);
      ws.on("finish", () => resolve());
      ws.on("error", (e) => reject(e));
    });
    return `/audio/${fname}`;
  }

  // Fallback: try JSON with base64
  if ((res as any).base64_audio) {
    const b = Buffer.from((res as any).base64_audio, "base64");
    fs.writeFileSync(outPath, b);
    return `/audio/${fname}`;
  }

  throw new Error("Couldn't save TTS output — unknown response type from OpenAI SDK");
}