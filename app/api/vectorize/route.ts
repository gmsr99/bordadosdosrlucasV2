import { NextRequest, NextResponse } from 'next/server';
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('image') as File;
        const colorCount = parseInt(formData.get('colorCount') as string) || 4;

        if (!file) {
            return NextResponse.json({ error: 'No image provided' }, { status: 400 });
        }

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        console.log(`[API] Vectorize request received. Buffer size: ${buffer.length}`);

        // VTracer (via @neplex/vectorizer) Configuration
        console.log('[API] Calling vectorize...');
        const svg = await vectorize(buffer, {
            colorMode: 0, // ColorMode.Color
            colorPrecision: 6,
            filterSpeckle: 4,
            cornerThreshold: 60,
            hierarchical: 0, // Hierarchical.Stacked
            mode: 2, // PathSimplifyMode.Spline
            layerDifference: 16,
            pathPrecision: 8,
            lengthThreshold: 10,
            maxIterations: 10,
            spliceThreshold: 45
        } as any);
        console.log('[API] Vectorization successful. SVG length:', svg.length);

        return new NextResponse(svg, {
            headers: {
                'Content-Type': 'image/svg+xml',
            },
        });

    } catch (error) {
        console.error('[API] Vectorization error details:', error);
        return NextResponse.json(
            { error: 'Vectorization failed', details: error instanceof Error ? error.message : String(error) },
            { status: 500 }
        );
    }
}
