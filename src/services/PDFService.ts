import fs from "fs";
import pdf from "pdf-parse";

export async function extractTextFromPdf(path: string): Promise<string> {
  const data = fs.readFileSync(path);
  const parsed = await pdf(data);
  return parsed.text || "";
}