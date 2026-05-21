import { GoogleGenAI, Modality } from "@google/genai";

function createImageAiClient(): GoogleGenAI {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY must be set. Please add your Gemini API key to the Replit Secrets.",
    );
  }

  if (baseUrl) {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: "",
        baseUrl,
      },
    });
  }

  return new GoogleGenAI({ apiKey });
}

let _imageClient: GoogleGenAI | null = null;

export const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    if (!_imageClient) {
      _imageClient = createImageAiClient();
    }
    const value = (_imageClient as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") {
      return value.bind(_imageClient);
    }
    return value;
  },
});

export async function generateImage(
  prompt: string
): Promise<{ b64_json: string; mimeType: string }> {
  const client = _imageClient ?? (_imageClient = createImageAiClient());
  const response = await client.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error("No image data in response");
  }

  return {
    b64_json: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}
