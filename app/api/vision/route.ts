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

        // --- VISION PROMPT STRATEGY (Updated) ---
        let systemPrompt = `
ROLE:
You are an image pre-processing engine in an embroidery auto-vectorization pipeline.
Your job is to transform the input image into a clean "Pre-Production Bitmap" that will later be auto-traced into SVG and converted to stitches.

TASK:
Analyze the input image and generate a bitmap that is optimized for automatic vector tracing and embroidery.

STRICT OUTPUT RULES:
1. OUTPUT FORMAT:
   - Return only a raster image as a CLEAN, FLAT PNG.
   - Do NOT generate SVG code.
   - Do NOT include any text, captions or explanations in the response, only the image.

2. BACKGROUND:
   - REMOVE THE BACKGROUND COMPLETELY.
   - Replace it with a PURE WHITE background (#FFFFFF).
   - No shadows, no gradients, no textures, no vignettes.

3. SUBJECT AND COMPOSITION:
   - Keep the main subject fully visible and not cropped.
   - Preserve the original pose and proportions of the subject.
   - Do NOT add new objects, logos, text or decorations that were not in the original image.

4. GRADIENTS AND SHADING:
   - NO GRADIENTS.
   - Flatten all gradients and soft shading into solid color regions.
   - Do NOT simulate gradients using dithering, noise or halftone patterns.

5. EDGES AND ANTI-ALIASING:
   - NO ANTI-ALIASING on the SUBJECT edges.
   - Edges must be sharp, crisp and aliased, with no soft blur and no semi-transparent pixels on the borders.
   - Avoid glow, feathering, motion blur or soft eraser effects.

6. CLEANUP AND SIMPLIFICATION:
   - Remove small "confetti" noise pixels and tiny isolated spots.
   - Simplify details that are too fine for embroidery, while keeping the main shapes and recognisable features.

7. SIZE AND ASPECT RATIO:
   - Keep the same aspect ratio as the original image.
   - Use a resolution high enough for clean vector tracing (at least 1024 pixels on the longest side, if possible).

STYLE SPECIFIC:
`;

        if (designStyle === 'vintage') {
            systemPrompt += `
STYLE: "Vintage" Redwork / Skeleton Line Art
- CONTENT: Black lines on a pure White background.
- LINES: Consistent line width, clean and continuous.
- SHAPES: Use outlines only, no filled areas.
- SIMPLIFY: Emphasize key contours and important interior lines. Avoid dense hatching or shading.`;
        } else if (designStyle === 'patch_line') {
            systemPrompt += `
STYLE: Bold Patch Outline
- CONTENT: Thick black shapes on a pure White background.
- SHAPES: The black shapes define the filled patch areas.
- INTENT: These black areas will be filled with Tatami stitch, so make them chunky and well separated.
- AVOID: Tiny holes, very thin gaps or micro-details inside shapes.`;
        } else {
            systemPrompt += `
STYLE: "Poster Art" / Vector Illustration
- CONTENT: High-contrast, flat vector art style.
- PALETTE: Reduce the SUBJECT colors to EXACTLY ${colorCount || 4} solid, high-contrast colors. Do NOT count the white background as a color. Avoid near-duplicate shades.
- SIMPLIFICATION: Aggressively simplify complex details into bold, solid color shapes.
- LOOK: Like a screen print or a vintage travel poster.
- INTENT: Multi-color Tatami fill. Each color region must be large enough to be embroidered.
- AVOID: Realism, photographic shading, textures, or small isolated pixels.`;
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
        const parts = candidates?.[0]?.content?.parts;
        if (parts) {
            for (const part of parts) {
                if (part.inlineData?.data) {
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
