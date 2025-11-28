import { VectorLayer, Point } from '../types';
import { parseSVG, makeAbsolute } from 'svg-path-parser';

// Helper to flatten Bezier curves into points
const flattenCommand = (cmd: any, currentX: number, currentY: number): Point[] => {
    const points: Point[] = [];

    if (cmd.code === 'M' || cmd.code === 'L') {
        points.push({ x: cmd.x, y: cmd.y });
    } else if (cmd.code === 'H') {
        points.push({ x: cmd.x, y: currentY });
    } else if (cmd.code === 'V') {
        points.push({ x: currentX, y: cmd.y });
    } else if (cmd.code === 'C') {
        // Cubic Bezier: current -> (x1,y1) -> (x2,y2) -> (x,y)
        // Simple flattening: 5 steps
        for (let t = 0.2; t <= 1.0; t += 0.2) {
            const x = Math.pow(1 - t, 3) * currentX +
                3 * Math.pow(1 - t, 2) * t * cmd.x1 +
                3 * (1 - t) * Math.pow(t, 2) * cmd.x2 +
                Math.pow(t, 3) * cmd.x;
            const y = Math.pow(1 - t, 3) * currentY +
                3 * Math.pow(1 - t, 2) * t * cmd.y1 +
                3 * (1 - t) * Math.pow(t, 2) * cmd.y2 +
                Math.pow(t, 3) * cmd.y;
            points.push({ x, y });
        }
    } else if (cmd.code === 'Q') {
        // Quadratic Bezier: current -> (x1,y1) -> (x,y)
        for (let t = 0.2; t <= 1.0; t += 0.2) {
            const x = Math.pow(1 - t, 2) * currentX +
                2 * (1 - t) * t * cmd.x1 +
                Math.pow(t, 2) * cmd.x;
            const y = Math.pow(1 - t, 2) * currentY +
                2 * (1 - t) * t * cmd.y1 +
                Math.pow(t, 2) * cmd.y;
            points.push({ x, y });
        }
    } else if (cmd.code === 'S') {
        // Smooth Cubic Bezier (simplified: treat as Q or C with reflection? For now linear fallback or just end point)
        // Ideally should reflect previous control point. 
        // Fallback: Line to end
        points.push({ x: cmd.x, y: cmd.y });
    } else if (cmd.code === 'T') {
        // Smooth Quadratic Bezier
        // Fallback: Line to end
        points.push({ x: cmd.x, y: cmd.y });
    } else if (cmd.code === 'Z') {
        // Close path - handled by logic
    }

    return points;
};

export const processVTracer = async (
    imageData: ImageData,
    widthMm: number,
    colorCount: number
): Promise<{ layers: VectorLayer[], svgPaths: string, colors: string[] }> => {

    // Convert ImageData to Blob/File to send to API
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Canvas context failed");
    ctx.putImageData(imageData, 0, 0);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error("Failed to convert image to blob");

    const formData = new FormData();
    formData.append('image', blob);
    formData.append('colorCount', colorCount.toString());

    // Call local API
    const response = await fetch('/api/vectorize', {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        throw new Error(`Vectorization API failed: ${response.statusText}`);
    }

    const svgString = await response.text();

    return parseSvgToLayers(svgString, imageData.width, imageData.height, widthMm);
};

export const parseSvgToLayers = (
    svgString: string,
    pixelWidth: number, // Fallback width if viewBox missing
    pixelHeight: number, // Fallback height if viewBox missing
    widthMm: number
): { layers: VectorLayer[], svgPaths: string, colors: string[] } => {
    const layers: VectorLayer[] = [];
    const colorMap: Map<string, Point[][]> = new Map();

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");

    // Determine coordinate system size from viewBox
    const svgEl = doc.querySelector('svg');
    let viewBoxWidth = pixelWidth;
    let viewBoxHeight = pixelHeight;
    let cx = pixelWidth / 2;
    let cy = pixelHeight / 2;

    if (svgEl) {
        const viewBox = svgEl.getAttribute('viewBox');
        if (viewBox) {
            const parts = viewBox.split(/\s+|,/).map(parseFloat);
            if (parts.length === 4) {
                viewBoxWidth = parts[2];
                viewBoxHeight = parts[3];
                // We assume viewBox starts at 0,0 for simplicity or handle offset if needed
                // But for centering, we use the width/height
            }
        } else {
            // Try width/height attributes
            const w = svgEl.getAttribute('width');
            const h = svgEl.getAttribute('height');
            if (w && h) {
                viewBoxWidth = parseFloat(w);
                viewBoxHeight = parseFloat(h);
            }
        }
        cx = viewBoxWidth / 2;
        cy = viewBoxHeight / 2;
    }

    const pixelsPerMm = viewBoxWidth / widthMm;

    const pathEls = doc.querySelectorAll('path');

    pathEls.forEach(pathEl => {
        const d = pathEl.getAttribute('d');
        if (!d) return;

        let fill = pathEl.getAttribute('fill');

        // Handle style attribute
        if (!fill) {
            const style = pathEl.getAttribute('style');
            if (style) {
                const fillMatch = style.match(/fill:\s*([^;"]+)/);
                if (fillMatch) fill = fillMatch[1].trim();
            }
        }

        if (!fill || fill === 'none') {
            // Check computed style? No, not attached to DOM.
            // Default to black if not specified? Or skip?
            // If it's a stroke-only path, we might want to skip or handle differently.
            // For patch fill, we need fill.
            // Let's assume black if missing, unless explicitly none.
            if (fill === 'none') return;
            fill = '#000000';
        }

        // Parse path data
        // We need makeAbsolute to handle relative commands correctly
        const commands = makeAbsolute(parseSVG(d));

        const pathPoints: Point[] = [];
        let currentX = 0;
        let currentY = 0;

        // Initialize current position from first Move command
        if (commands.length > 0 && commands[0].code === 'M') {
            currentX = commands[0].x;
            currentY = commands[0].y;
        }

        for (const cmd of commands) {
            const pts = flattenCommand(cmd, currentX, currentY);
            if (pts.length > 0) {
                // Convert pixels to mm relative to center
                const mmPts = pts.map(p => ({
                    x: (p.x - cx) / pixelsPerMm,
                    y: (cy - p.y) / pixelsPerMm
                }));
                pathPoints.push(...mmPts);

                const last = pts[pts.length - 1];
                // Note: flattenCommand returns absolute points, but we need to track current pos
                // Actually flattenCommand implementation above calculates absolute points based on currentX/Y
                // But for M/L/C/Q in makeAbsolute, x/y are absolute.
                // My flattenCommand implementation uses cmd.x/y directly for M/L.
                // For C/Q it uses cmd.x/y as target.
                // So the points returned ARE absolute.
                // We just need to update currentX/Y to the last point.

                // Wait, flattenCommand implementation above:
                // if M/L: points.push({x: cmd.x, y: cmd.y}) -> cmd.x is absolute because of makeAbsolute
                // So yes, points are absolute.

                // Update currentX/Y for next command (needed for H/V/relative logic if not fully absolute)
                // makeAbsolute makes coords absolute, but H/V might still need current context if converted to L?
                // makeAbsolute converts H/V to L usually? No, it keeps H/V but makes args absolute.
                // If H x=10, and we are at 5, it means line to 10.
                // My flattenCommand handles H/V using currentY/currentX.

                // So we need to update currentX/Y.
                // But wait, flattenCommand returns points. The last point IS the new current position.
                // UNLESS it's Z.
                if (cmd.code !== 'Z') {
                    // For M, L, C, Q, S, T, A, H, V the command ends at a specific point.
                    // makeAbsolute ensures cmd.x/cmd.y exists for most.
                    // For H, cmd.x exists. For V, cmd.y exists.

                    // Let's rely on the last emitted point.
                    currentX = last.x;
                    currentY = last.y;
                }
            }
        }

        if (pathPoints.length > 2) {
            if (!colorMap.has(fill)) {
                colorMap.set(fill, []);
            }
            colorMap.get(fill)?.push(pathPoints);
        }
    });

    // Convert Map to VectorLayer[]
    colorMap.forEach((paths, color) => {
        layers.push({ color, paths });
    });

    return {
        layers,
        svgPaths: svgString, // Return raw SVG for preview
        colors: Array.from(colorMap.keys())
    };
};
