import { openai } from "../openAIClient";

export async function generateScriptAndKeyPoints(paperText: string, minutes = 10) {
  const system = `You are an expert science communicator. Use only the content provided. Don't use any external references. Produce:
1) A structured summary with introduction, main problem, approach, key results, and limitations.
2) A list of 15 concise key points grouped based on content semantic.
3) A podcast-style spoken script suitable for ${minutes} minute narration. Do not include intro/outro music.`;

  // Create a single responses API call that asks for all three pieces.
  const resp = await openai.responses.create({
    model: "gpt-4o-mini", // replace with the model you have access to, e.g. "gpt-4o-mini"
    input: [
      { role: "system", content: system },
      { role: "user", content: paperText.slice(0, 200000) }
    ],
    max_output_tokens: 2000
  });

  // Helper to extract textual output robustly
  function extractText(r: any): string {
    if (!r) return "";
    if (typeof r.output_text === "string" && r.output_text.trim()) {
      return r.output_text;
    }
    // Otherwise try to walk the output array
    if (Array.isArray(r.output)) {
      const parts: string[] = [];
      for (const item of r.output) {
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
            if (c.type === "output_text" && c.text == null && typeof c === "string") parts.push(String(c));
            if (c.type === "answer" && typeof c.text === "string") parts.push(c.text);
            // fallback: join any plain strings
            if (typeof c === "string") parts.push(c);
          }
        } else if (item.content && typeof item.content === "string") {
          parts.push(item.content);
        }
      }
      return parts.join("\n\n");
    }
    return "";
  }

  const full = extractText(resp);

  // Try to split: look for markers in output (many prompts produce sections)
  // We'll attempt to find "KEY POINTS" or "Key points" and "PODCAST SCRIPT"
  let summary = "";
  let keyPoints: string[] = [];
  let script = "";

  // Simple heuristics
  const kpMarker = /key points[:\s\-]+/i;
  const scriptMarker = /podcast script[:\s\-]+/i;

  const lc = full;

  // If markers exist, split using them
  const kpIdx = lc.search(kpMarker);
  const scriptIdx = lc.search(scriptMarker);

  if (kpIdx !== -1 && scriptIdx !== -1) {
    summary = full.slice(0, kpIdx).trim();
    keyPoints = full.slice(kpIdx, scriptIdx).split(/\r?\n/).map(l => l.replace(/^[\-\d\.\)\s]+/, "").trim()).filter(Boolean);
    script = full.slice(scriptIdx).replace(scriptMarker, "").trim();
  } else {
    // fallback: ask the model to extract keypoints if not split nicely
    // We'll perform a second call to get key points explicitly
    const kpResp = await openai.responses.create({
      model: "gpt-5",
      input: [
        { role: "system", content: "Extract 15-20 concise key points grouped semantically from the following summary." },
        { role: "user", content: full.slice(0, 12000) }
      ],
      max_output_tokens: 300
    });

    const kpText = (kpResp.output_text ?? "") || (Array.isArray(kpResp.output) ? kpResp.output.map((o:any)=> (o.content?.map((c:any)=>c.text).join("") || "")).join("\n") : "");
    keyPoints = kpText.split(/\r?\n/).map(l => l.replace(/^[\-\•\d\.\)\s]+/, "").trim()).filter(Boolean);

    // Use first ~3k chars as summary and entire output as script fallback
    summary = full.slice(0, 3000);
    script = full;
  }

  return { summary, keyPoints, script };
}