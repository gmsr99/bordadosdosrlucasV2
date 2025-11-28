import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from "@google/genai";

export async function POST(req: NextRequest) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return NextResponse.json(
                { error: "Server configuration error: Missing API Key" },
                { status: 500 }
            );
        }

        const body = await req.json();
        const { base64Image, promptDetail, colorCount, designStyle } = body;

        if (!base64Image) {
            return NextResponse.json(
                { error: "Missing image data" },
                { status: 400 }
            );
        }

        const ai = new GoogleGenAI({ apiKey });
        const cleanBase64 = base64Image.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');

        // --- VISION PROMPT STRATEGY (Reused from original service) ---
        let systemPrompt = `You are an expert textile digitizer preparing an image for an industrial embroidery machine.
    
    TASK:
    Analyze the input image and generate a "Pre-Production Bitmap" optimized for auto-vectorization.
    
    CRITICAL RULES:
    1. OUTPUT FORMAT: Return a CLEAN, FLAT PNG image. Do NOT generate SVG code.
    2. PALETTE: Reduce the image to EXACTLY ${colorCount || 4} high-contrast colors + White background.
    3. NO GRADIENTS: Flatten all gradients to solid blocks. Embroidery cannot do gradients.
    4. NO ANTI-ALIASING: Edges must be sharp (aliased) for perfect vector tracing.
    5. SIMPLIFY: Remove small "confetti" noise pixels.
    
    STYLE SPECIFIC:`;

        if (designStyle === 'vintage') {
            systemPrompt += `
      - STYLE: Redwork / Skeleton Line Art.
      - CONTENT: Black lines on White background.
      - THICKNESS: Consistent line width.
      - ISOLATE: Remove background entirely.`;
        } else if (designStyle === 'patch_line') {
            systemPrompt += `
      - STYLE: Bold Patch Outline.
      - CONTENT: Thick Black shapes on White background.
      - INTENT: These black shapes will be filled with Tatami stitch, so make them chunky.`;
        } else {
            systemPrompt += `
      - STYLE: Posterized / Patch Fill.
      - CONTENT: Solid color regions separated by clear boundaries.
      - INTENT: Multi-color Tatami fill.`;
        }

        console.log(`[API] Sending to Gemini Vision... Style: ${designStyle}`);

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
                parts: [
                    { inlineData: { data: cleanBase64, mimeType: 'image/png' } },
                    { text: `${systemPrompt} ${promptDetail || ""}` },
                ],
            },
        });

        const candidates = response.candidates;
        if (candidates && candidates.length > 0) {
            for (const part of candidates[0].content.parts) {
                if (part.inlineData && part.inlineData.data) {
                    const resultImage = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
                    return NextResponse.json({ resultImage });
                }
            }
        }

        return NextResponse.json(
            { error: "Gemini did not return an image." },
            { status: 500 }
        );

    } catch (error: any) {
        console.error("Gemini Vision API Error:", error);
        return NextResponse.json(
            { error: error.message || "Internal Server Error" },
            { status: 500 }
        );
    }
}
