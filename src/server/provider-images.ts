import sharp from "sharp";
import type { Context, ImageContent } from "@earendil-works/pi-ai";

const providerFormats = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Keep originals in storage; only model-facing bytes need a portable format. */
export async function prepareProviderImage(image: ImageContent): Promise<ImageContent> {
  if (providerFormats.has(image.mimeType)) return image;
  try {
    const png = await sharp(Buffer.from(image.data, "base64")).rotate().png().toBuffer();
    return { ...image, mimeType: "image/png", data: png.toString("base64") };
  } catch (error) {
    throw new Error(
      `Cannot convert ${image.mimeType} image for the model: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Replay old uploads and tool/memory images without rewriting durable history. */
export async function projectProviderImages(request: Context): Promise<Context> {
  const messages = await Promise.all(
    request.messages.map(async (message) => {
      if (
        message.role === "assistant" ||
        message.role === "system" ||
        typeof message.content === "string"
      )
        return message;
      const content = await Promise.all(
        message.content.map((block) =>
          block.type === "image" ? prepareProviderImage(block) : block,
        ),
      );
      return { ...message, content };
    }),
  );
  return { ...request, messages };
}
