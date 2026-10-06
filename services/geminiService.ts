import { Platform } from "../types";

/**
 * Gemini Service - Proxy via Cloudflare Pages Functions
 * This avoids exposing the API Key in the browser and resolves the "API Key must be set" error.
 */

const API_BASE = "/api/ai/gemini";

export const generateAdCopy = async (
  productName: string,
  description: string,
  platform: Platform,
  tone: string
): Promise<string> => {
  try {
    const prompt = `
      You are a world-class digital marketer.
      Create a compelling ad copy for the following product:
      Product: ${productName}
      Description: ${description}
      Target Platform: ${platform}
      Tone: ${tone}

      Requirements:
      - Keep it optimized for the specific platform (e.g., hashtags for TikTok, professional for LinkedIn/Google).
      - Include a headline and a body text.
      - Use emojis where appropriate for the platform.
      - Return ONLY the ad copy text.
    `;

    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: 'gemini-2.0-flash',
        config: {
          temperature: 0.8,
          topK: 40,
          topP: 0.95,
        }
      })
    });

    if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Backend API error");
    }

    const data = await response.json();
    return data.text || "Failed to generate content.";
  } catch (error: any) {
    console.error("Gemini Proxy Error:", error);
    throw new Error(error.message || "Could not generate ad copy.");
  }
};

export const analyzeProfileData = async (dataSnippet: string): Promise<string> => {
   try {
    const prompt = `
      Analyze this CSV data snippet of browser profiles and provide a brief summary of potential risks or grouping strategies.
      Data: ${dataSnippet}
      Keep it under 50 words.
    `;

    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: 'gemini-2.0-flash'
      })
    });

    if (!response.ok) return "Analysis unavailable.";

    const data = await response.json();
    return data.text || "Analysis failed.";
   } catch (error) {
     return "Analysis unavailable.";
   }
}
