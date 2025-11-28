import { DesignStyle } from "../types";

export const simplifyImageWithAI = async (
  base64Image: string,
  promptDetail: string = "",
  colorCount: number = 4,
  designStyle: DesignStyle = 'patch_fill'
): Promise<string> => {

  try {
    const response = await fetch('/api/vision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base64Image,
        promptDetail,
        colorCount,
        designStyle
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to process image");
    }

    const data = await response.json();
    return data.resultImage;

  } catch (error) {
    console.error("Vision Service Error:", error);
    throw error;
  }
};
