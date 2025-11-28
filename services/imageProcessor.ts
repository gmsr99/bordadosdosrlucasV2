
import { Point, Stitch, StitchType, ProcessingConfig, DesignStyle, VectorLayer } from '../types';
import { Potrace } from './potrace';

// --- Constants from PDF ---
const PROCESS_WIDTH = 1024;
const MIN_PATH_LENGTH_PX = 4; // Reduced from 10 to 4 to capture fine details (Vintage Mode)

// --- Helper Functions ---

export const loadImage = (src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
};

const rgbToHex = (r: number, g: number, b: number) =>
    "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);

const dist = (p1: Point, p2: Point) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

// Squared distance is faster for comparisons (no sqrt)
const distSq = (p1: Point, p2: Point) => Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);

const rotatePoint = (p: Point, angleRad: number): Point => {
    return { x: p.x * Math.cos(angleRad) - p.y * Math.sin(angleRad), y: p.x * Math.sin(angleRad) + p.y * Math.cos(angleRad) };
};

const interpolatePoints = (p1: Point, p2: Point, t: number): Point => ({
    x: p1.x + (p2.x - p1.x) * t,
    y: p1.y + (p2.y - p1.y) * t
});

const normalize = (p: Point): Point => {
    const len = Math.sqrt(p.x * p.x + p.y * p.y);
    return len === 0 ? { x: 0, y: 0 } : { x: p.x / len, y: p.y / len };
};

const addPoints = (p1: Point, p2: Point): Point => ({ x: p1.x + p2.x, y: p1.y + p2.y });
const subPoints = (p1: Point, p2: Point): Point => ({ x: p1.x - p2.x, y: p1.y - p2.y });
const scalePoint = (p: Point, s: number): Point => ({ x: p.x * s, y: p.y * s });
const dotProduct = (p1: Point, p2: Point): number => p1.x * p2.x + p1.y * p2.y;

// Distance from point p to line segment ab
const pointLineDist = (p: Point, a: Point, b: Point): number => {
    const l2 = Math.pow(dist(a, b), 2);
    if (l2 === 0) return dist(p, a);
    const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    const tClamped = Math.max(0, Math.min(1, t));
    const projection = { x: a.x + tClamped * (b.x - a.x), y: a.y + tClamped * (b.y - a.y) };
    return dist(p, projection);
};

// --- GEOMETRY ENGINE (The "Invisible Algorithms") ---

// 0. SMOOTHING (Ramer-Douglas-Peucker)
const simplifyPath = (points: Point[], epsilon: number): Point[] => {
    if (points.length < 3) return points;

    let dmax = 0;
    let index = 0;
    const end = points.length - 1;

    for (let i = 1; i < end; i++) {
        const d = pointLineDist(points[i], points[0], points[end]);
        if (d > dmax) {
            index = i;
            dmax = d;
        }
    }

    if (dmax > epsilon) {
        const recResults1 = simplifyPath(points.slice(0, index + 1), epsilon);
        const recResults2 = simplifyPath(points.slice(index), epsilon);
        return recResults1.slice(0, recResults1.length - 1).concat(recResults2);
    } else {
        return [points[0], points[end]];
    }
};

// 1. Polygon Offset (Pull Compensation / Underlay)
const offsetPolygon = (path: Point[], offsetMm: number): Point[] => {
    if (path.length < 3) return path;
    const result: Point[] = [];
    const len = path.length;

    for (let i = 0; i < len; i++) {
        const prev = path[(i - 1 + len) % len];
        const curr = path[i];
        const next = path[(i + 1) % len];

        // Edge vectors
        const v1 = normalize({ x: curr.x - prev.x, y: curr.y - prev.y });
        const v2 = normalize({ x: next.x - curr.x, y: next.y - curr.y });

        // Normal vectors (-y, x)
        const n1 = { x: -v1.y, y: v1.x };
        const n2 = { x: -v2.y, y: v2.x };

        // Average normal (Vertex normal)
        const avgN = normalize(addPoints(n1, n2));

        const dot = n1.x * n2.x + n1.y * n2.y;
        let miter = 1 / Math.max(0.1, (1 + dot) / 2);
        miter = Math.min(miter, 2.0);

        result.push(addPoints(curr, scalePoint(avgN, offsetMm * miter)));
    }
    return result;
};

// 2. Resampling & Smoothing
const resamplePath = (path: Point[], spacing: number): Point[] => {
    if (path.length < 2) return path;
    const newPath: Point[] = [path[0]];
    let prev = path[0];
    let accumulatedDist = 0;
    for (let i = 1; i < path.length; i++) {
        const curr = path[i];
        const d = dist(prev, curr);
        if (accumulatedDist + d >= spacing) {
            const needed = spacing - accumulatedDist;
            const ratio = needed / d;
            const nextPoint = interpolatePoints(prev, curr, ratio);
            newPath.push(nextPoint);
            prev = nextPoint; accumulatedDist = 0; i--;
        } else { accumulatedDist += d; prev = curr; }
    }
    newPath.push(path[path.length - 1]);
    return newPath;
};

// 3. SEQUENCE OPTIMIZATION (Closest Join)
const reorderPolygonToStartAt = (path: Point[], bestIdx: number): Point[] => {
    if (bestIdx === 0) return path;
    const uniquePoints = path.slice(0, path.length - 1);
    const part1 = uniquePoints.slice(bestIdx);
    const part2 = uniquePoints.slice(0, bestIdx);
    const rotated = [...part1, ...part2];
    rotated.push(rotated[0]);
    return rotated;
};

const optimizePathSequence = (paths: Point[][]): Point[][] => {
    if (paths.length === 0) return [];

    const optimized: Point[][] = [];
    const remaining = [...paths];

    let currentPos: Point = { x: 0, y: 0 };

    while (remaining.length > 0) {
        let bestPathIdx = -1;
        let bestVertexIdx = -1;
        let minDistanceSq = Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const path = remaining[i];
            for (let v = 0; v < path.length - 1; v++) {
                const dSq = distSq(currentPos, path[v]);
                if (dSq < minDistanceSq) {
                    minDistanceSq = dSq;
                    bestPathIdx = i;
                    bestVertexIdx = v;
                }
            }
        }

        if (bestPathIdx !== -1) {
            const chosenPath = remaining[bestPathIdx];
            const reorderedPath = reorderPolygonToStartAt(chosenPath, bestVertexIdx);
            optimized.push(reorderedPath);
            currentPos = reorderedPath[reorderedPath.length - 1];
            remaining.splice(bestPathIdx, 1);
        } else {
            if (remaining.length > 0) {
                optimized.push(remaining[0]);
                remaining.shift();
            }
        }
    }
    return optimized;
};

// --- STITCH GENERATION ENGINE ---

const generateSatinStitches = (pathMm: Point[], config: ProcessingConfig, colorIdx: number, hexColor: string): Stitch[] => {
    const stitches: Stitch[] = [];
    if (pathMm.length < 2) return stitches;

    const halfWidth = (config.satinColumnWidthMm / 2) + (config.pullCompensationMm / 2);
    const spacing = config.densityMm;
    const resampled = resamplePath(pathMm, spacing);

    const leftRail: Point[] = [];
    const rightRail: Point[] = [];

    for (let i = 0; i < resampled.length; i++) {
        const curr = resampled[i];
        const prev = i > 0 ? resampled[i - 1] : subPoints(curr, subPoints(resampled[i + 1], curr));
        const next = i < resampled.length - 1 ? resampled[i + 1] : addPoints(curr, subPoints(curr, resampled[i - 1]));

        const v1 = normalize(subPoints(curr, prev));
        const v2 = normalize(subPoints(next, curr));
        const n1 = { x: -v1.y, y: v1.x };

        const tangentSum = addPoints(v1, v2);
        const tangentLen = Math.sqrt(tangentSum.x * tangentSum.x + tangentSum.y * tangentSum.y);

        let miterVector: Point;
        let miterLength = halfWidth;

        if (tangentLen < 0.001) {
            miterVector = n1;
        } else {
            const bisector = normalize(tangentSum);
            miterVector = { x: -bisector.y, y: bisector.x };
            const dot = dotProduct(miterVector, n1);
            if (Math.abs(dot) > 0.1) {
                miterLength = halfWidth / dot;
            }
        }

        const MITER_LIMIT = halfWidth * 3.0;
        if (miterLength > MITER_LIMIT) miterLength = MITER_LIMIT;

        leftRail.push(addPoints(curr, scalePoint(miterVector, miterLength)));
        rightRail.push(subPoints(curr, scalePoint(miterVector, miterLength)));
    }

    for (let i = 0; i < leftRail.length; i++) {
        let p1 = leftRail[i];
        let p2 = rightRail[i];

        if (i > 0) {
            const prevP1 = leftRail[i - 1];
            const prevP2 = rightRail[i - 1];
            const dLeft = dist(p1, prevP1);
            const dRight = dist(p2, prevP2);

            const SHORTENING_RATIO = 0.6;
            const CRITICAL_DENSITY = 0.4;
            const SHORTEN_AMOUNT = 0.3;

            if (i % 2 !== 0) {
                if (dLeft < dRight * SHORTENING_RATIO && dLeft < CRITICAL_DENSITY) {
                    p1 = interpolatePoints(p1, p2, SHORTEN_AMOUNT);
                } else if (dRight < dLeft * SHORTENING_RATIO && dRight < CRITICAL_DENSITY) {
                    p2 = interpolatePoints(p2, p1, SHORTEN_AMOUNT);
                }
            }
        }

        const currentLen = dist(p1, p2);

        if (currentLen > config.maxStitchLengthMm) {
            const maxLen = config.maxStitchLengthMm || 7.0;
            const steps = Math.ceil(currentLen / maxLen);
            const idealSegLen = currentLen / steps;
            const maxSafeShift = maxLen - idealSegLen - 0.1; // Safety margin

            stitches.push({ x: p1.x, y: p1.y, type: 'stitch', colorIndex: colorIdx, hexColor });

            for (let k = 1; k < steps; k++) {
                let t = k / steps;

                // Apply shift to avoid railroading (grooves)
                if (maxSafeShift > 0.5) {
                    // Pattern: Center, Right, Left
                    const pattern = [0, 0.5, -0.5];
                    const shiftMm = pattern[i % 3] * Math.min(maxSafeShift, 2.0);
                    const shiftT = shiftMm / currentLen;
                    t += shiftT;
                }

                const mid = interpolatePoints(p1, p2, t);
                stitches.push({ x: mid.x, y: mid.y, type: 'stitch', colorIndex: colorIdx, hexColor });
            }
            stitches.push({ x: p2.x, y: p2.y, type: 'stitch', colorIndex: colorIdx, hexColor });
        } else {
            stitches.push({ x: p1.x, y: p1.y, type: 'stitch', colorIndex: colorIdx, hexColor });
            stitches.push({ x: p2.x, y: p2.y, type: 'stitch', colorIndex: colorIdx, hexColor });
        }
    }

    return stitches;
};

const generateTatamiStitches = (shapePathsMm: Point[][], config: ProcessingConfig, colorIdx: number, hexColor: string): Stitch[] => {
    const stitches: Stitch[] = [];
    if (shapePathsMm.length === 0) return stitches;

    const compensatedPaths = shapePathsMm.map(p => offsetPolygon(p, config.pullCompensationMm));
    const angleRad = -config.tatamiAngle * (Math.PI / 180);
    const invAngle = -angleRad;
    const rotatedPaths = compensatedPaths.map(path => path.map(p => rotatePoint(p, angleRad)));

    let minY = Infinity, maxY = -Infinity;
    rotatedPaths.forEach(path => { path.forEach(p => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }); });

    const edges: { p1: Point, p2: Point }[] = [];
    rotatedPaths.forEach(path => {
        for (let i = 0; i < path.length - 1; i++) {
            if (Math.abs(path[i].y - path[i + 1].y) > 0.001) {
                if (path[i].y < path[i + 1].y) edges.push({ p1: path[i], p2: path[i + 1] });
                else edges.push({ p1: path[i + 1], p2: path[i] });
            }
        }
        const last = path[path.length - 1]; const first = path[0];
        if (Math.abs(last.y - first.y) > 0.001) {
            if (last.y < first.y) edges.push({ p1: last, p2: first });
            else edges.push({ p1: first, p2: last });
        }
    });

    const rowSpacing = config.densityMm;
    const stitchLen = 4.0;
    const maxSatinLen = config.maxStitchLengthMm || 7.0;

    for (let y = minY + rowSpacing; y < maxY; y += rowSpacing) {
        const intersections: number[] = [];
        for (const edge of edges) {
            const y1 = edge.p1.y; const y2 = edge.p2.y;
            if (y1 <= y && y2 > y) {
                const x = edge.p1.x + (y - y1) * (edge.p2.x - edge.p1.x) / (y2 - y1);
                intersections.push(x);
            }
        }
        intersections.sort((a, b) => a - b);

        for (let i = 0; i < intersections.length; i += 2) {
            if (i + 1 >= intersections.length) break;
            const xStart = intersections[i];
            const xEnd = intersections[i + 1];
            const segmentLen = xEnd - xStart;

            if (segmentLen < 0.5) continue;

            const lineStitches: Point[] = [];

            if (segmentLen <= maxSatinLen) {
                lineStitches.push({ x: xStart, y: y });
                lineStitches.push({ x: xEnd, y: y });
            } else {
                // Tatami Randomness (Anti-Railroading)
                // We use a deterministic "random" based on Y to allow re-runs to be consistent
                const pseudoRandom = Math.sin(y * 123.45) * 10000;
                const noise = (pseudoRandom - Math.floor(pseudoRandom)) * 0.4; // 0.0 to 0.4 variance

                const offsetFraction = ((Math.abs(Math.round(y * 10)) % 3) / 3.0) + noise;
                const rowOffset = offsetFraction * stitchLen;

                let currX = xStart + ((stitchLen - rowOffset) % stitchLen);
                if (currX <= xStart) currX += stitchLen;

                lineStitches.push({ x: xStart, y: y });
                while (currX < xEnd) {
                    lineStitches.push({ x: currX, y: y });
                    currX += stitchLen;
                }
                lineStitches.push({ x: xEnd, y: y });
            }

            const isReverse = Math.round(y / rowSpacing) % 2 === 0;
            if (isReverse) lineStitches.reverse();

            const firstP = rotatePoint(lineStitches[0], invAngle);
            if (stitches.length > 0) {
                const lastStitch = stitches[stitches.length - 1];
                const d = dist(lastStitch, firstP);
                if (d > 2.0) {
                    stitches.push({ ...firstP, type: 'jump', colorIndex: colorIdx, hexColor, isStructure: true });
                } else if (d > 0.1) {
                    stitches.push({ ...firstP, type: 'stitch', colorIndex: colorIdx, hexColor });
                }
            } else {
                stitches.push({ ...firstP, type: 'jump', colorIndex: colorIdx, hexColor, isStructure: true });
            }

            for (let k = 1; k < lineStitches.length; k++) {
                const p = rotatePoint(lineStitches[k], invAngle);
                stitches.push({ x: p.x, y: p.y, type: 'stitch', colorIndex: colorIdx, hexColor });
            }
        }
    }
    return stitches;
};

const generateRunningStitches = (pathMm: Point[], config: ProcessingConfig, colorIdx: number, hexColor: string): Stitch[] => {
    const stitches: Stitch[] = [];
    if (pathMm.length < 2) return stitches;

    // 1. Clean path (remove duplicates)
    const cleanPath: Point[] = [pathMm[0]];
    for (let i = 1; i < pathMm.length; i++) {
        if (dist(cleanPath[cleanPath.length - 1], pathMm[i]) > 0.01) {
            cleanPath.push(pathMm[i]);
        }
    }

    if (cleanPath.length < 2) return stitches;

    stitches.push({ x: cleanPath[0].x, y: cleanPath[0].y, type: 'stitch', colorIndex: colorIdx, hexColor });

    // Use config for Max Stitch Length (Variable Run Length)
    const MAX_RUN_LEN = config.maxStitchLengthMm > 0 ? config.maxStitchLengthMm : 2.5;

    for (let i = 1; i < cleanPath.length; i++) {
        const prev = cleanPath[i - 1];
        const curr = cleanPath[i];
        const d = dist(prev, curr);

        if (d > MAX_RUN_LEN) {
            const steps = Math.ceil(d / MAX_RUN_LEN);
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const p = interpolatePoints(prev, curr, t);
                stitches.push({ x: p.x, y: p.y, type: 'stitch', colorIndex: colorIdx, hexColor });
            }
        } else {
            stitches.push({ x: curr.x, y: curr.y, type: 'stitch', colorIndex: colorIdx, hexColor });
        }
    }

    return stitches;
};

const generateUnderlay = (pathMm: Point[], config: ProcessingConfig, colorIdx: number, hexColor: string): Stitch[] => {
    if (!config.enableUnderlay) return [];

    let stitches: Stitch[] = [];

    if (config.stitchType === 'satin') {
        const width = config.satinColumnWidthMm;

        if (width < 2.0) {
            stitches = generateRunningStitches(pathMm, config, colorIdx, hexColor);
        } else {
            const inset = (width / 2) - 0.4;
            if (inset > 0) {
                stitches = generateSatinStitches(pathMm, { ...config, satinColumnWidthMm: inset * 2, densityMm: 2.0, pullCompensationMm: 0 }, colorIdx, hexColor);
            }
        }
    } else {
        const insetPoly = offsetPolygon(pathMm, -0.6);
        if (insetPoly.length > 2) {
            const run = generateRunningStitches(insetPoly, config, colorIdx, hexColor);
            // Note: generateRunningStitches returns standard stitches.
            // We need to mark them as structure.
            stitches = run.map(s => ({ ...s, isStructure: true }));

            // Ensure closed loop if it was closed
            if (run.length > 0) {
                stitches.push({ ...run[0], type: 'stitch', isStructure: true });
            }
        }
    }

    // Mark ALL underlay stitches as structure
    return stitches.map(s => ({ ...s, isStructure: true }));
};

const addTieIn = (stitches: Stitch[]): Stitch[] => {
    if (stitches.length === 0) return [];
    const first = stitches[0];
    if (first.type === 'jump' || first.type === 'end') return stitches;

    // Changed to 0.5mm Linear Backtrack (A -> B -> A) to be invisible but secure
    const tieIn: Stitch[] = [
        { x: first.x + 0.5, y: first.y, type: 'stitch', colorIndex: first.colorIndex, hexColor: first.hexColor, isStructure: true },
        { x: first.x, y: first.y, type: 'stitch', colorIndex: first.colorIndex, hexColor: first.hexColor, isStructure: true }
    ];
    return [...tieIn, ...stitches];
};

const addTieOff = (stitches: Stitch[]): Stitch[] => {
    if (stitches.length === 0) return [];
    const last = stitches[stitches.length - 1];
    if (last.type === 'jump' || last.type === 'end') return stitches;

    // Changed to 0.5mm Linear Backtrack (A -> B -> A) to be invisible but secure
    const tieOff: Stitch[] = [
        { x: last.x - 0.5, y: last.y, type: 'stitch', colorIndex: last.colorIndex, hexColor: last.hexColor, isStructure: true },
        { x: last.x, y: last.y, type: 'stitch', colorIndex: last.colorIndex, hexColor: last.hexColor, isStructure: true },
        { x: last.x, y: last.y, type: 'trim', colorIndex: last.colorIndex, hexColor: last.hexColor, isStructure: true }
    ];
    return [...stitches, ...tieOff];
};

const removeSmallStitches = (stitches: Stitch[], minLen: number): Stitch[] => {
    const result: Stitch[] = [stitches[0]];
    for (let i = 1; i < stitches.length; i++) {
        const prev = result[result.length - 1];
        const curr = stitches[i];
        if (curr.type === 'stitch') {
            const d = dist(prev, curr);
            if (d < minLen && d > 0.01) continue;
        }
        result.push(curr);
    }
    return result;
};

// --- CORE UTILS ---

const getLuminance = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return 0;
    const r = parseInt(result[1], 16), g = parseInt(result[2], 16), b = parseInt(result[3], 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
};
const colorDist = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) => Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
const extractDominantColors = (ctx: CanvasRenderingContext2D, width: number, height: number, k: number): { r: number, g: number, b: number, hex: string }[] => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const pixels: { r: number, g: number, b: number }[] = [];
    for (let i = 0; i < data.length; i += 80) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128 || (r > 230 && g > 230 && b > 230)) continue;
        pixels.push({ r, g, b });
    }
    if (pixels.length < k) return [{ r: 0, g: 0, b: 0, hex: '#000000' }];

    let centroids: { r: number, g: number, b: number, hex: string }[] = Array.from({ length: k }, () => {
        const p = pixels[Math.floor(Math.random() * pixels.length)];
        return { r: p.r, g: p.g, b: p.b, hex: rgbToHex(p.r, p.g, p.b) };
    });

    for (let iter = 0; iter < 5; iter++) {
        const clusters: any[][] = Array.from({ length: k }, () => []);
        for (const p of pixels) {
            let minDist = Infinity; let idx = 0;
            for (let c = 0; c < centroids.length; c++) {
                const d = Math.sqrt((p.r - centroids[c].r) ** 2 + (p.g - centroids[c].g) ** 2 + (p.b - centroids[c].b) ** 2);
                if (d < minDist) { minDist = d; idx = c; }
            }
            clusters[idx].push(p);
        }
        centroids = centroids.map((c, i) => {
            if (clusters[i].length === 0) return c;
            const r = clusters[i].reduce((s: number, p: any) => s + p.r, 0) / clusters[i].length;
            const g = clusters[i].reduce((s: number, p: any) => s + p.g, 0) / clusters[i].length;
            const b = clusters[i].reduce((s: number, p: any) => s + p.b, 0) / clusters[i].length;
            return { r, g, b, hex: rgbToHex(Math.round(r), Math.round(g), Math.round(b)) };
        });
    }
    return centroids;
};
const morphologyOpen = (grid: Int8Array, w: number, h: number, passes: number = 1) => {
    let current = grid;
    for (let p = 0; p < passes; p++) {
        const temp = new Int8Array(grid.length);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            if (current[idx] === 1 && current[idx - 1] && current[idx + 1] && current[idx - w] && current[idx + w]) temp[idx] = 1;
        }
        current = temp;
    }
    for (let p = 0; p < passes; p++) {
        const temp = new Int8Array(grid.length);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            if (current[idx] === 1) { temp[idx] = 1; temp[idx - 1] = 1; temp[idx + 1] = 1; temp[idx - w] = 1; temp[idx + w] = 1; }
        }
        current = temp;
    }
    return current;
};

// --- MAIN PROCESSOR (SPLIT PIPELINE) ---

// helper to trace from existing canvas directly
const traceCanvasWithPotrace = (canvas: HTMLCanvasElement): Point[][] => {
    Potrace.setParameter({
        turdsize: 2,
        optcurve: true,
        alphamax: 1,
        opttolerance: 0.2
    });

    Potrace.loadFromCanvas(canvas);
    Potrace.process(() => { });

    return extractPathsFromPotrace();
};

const extractPathsFromPotrace = (): Point[][] => {
    const paths = Potrace.getPaths();
    if (!paths || paths.length === 0) return [];

    const finalContours: Point[][] = [];

    paths.forEach((path: any) => {
        const contour: Point[] = [];
        const curve = path.curve;
        const n = curve.n;

        for (let i = 0; i < n; i++) {
            const startIdx = ((i - 1 + n) % n) * 3 + 2;
            const p0 = curve.c[startIdx];
            const p1 = curve.c[i * 3 + 0];
            const p2 = curve.c[i * 3 + 1];
            const p3 = curve.c[i * 3 + 2];

            if (curve.tag[i] === "CURVE") {
                const lenApprox = dist(p0, p3) + dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
                const steps = Math.ceil(lenApprox / 2);

                for (let t = 0; t < 1; t += 1 / steps) {
                    const mt = 1 - t;
                    const mt2 = mt * mt;
                    const mt3 = mt2 * mt;
                    const t2 = t * t;
                    const t3 = t2 * t;

                    const x = mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x;
                    const y = mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y;
                    contour.push({ x, y });
                }
            } else {
                contour.push({ x: p0.x, y: p0.y });
            }
        }
        if (contour.length > MIN_PATH_LENGTH_PX) {
            finalContours.push(contour);
        }
    });

    return finalContours;
};

// Replaces robustTraceContours with Real Potrace Engine (Bitmap input)
const traceBitmapWithPotrace = (binaryGrid: Int8Array, w: number, h: number): Point[][] => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];

    const imgData = ctx.createImageData(w, h);
    for (let i = 0; i < binaryGrid.length; i++) {
        const val = binaryGrid[i] === 1 ? 0 : 255;
        imgData.data[i * 4] = val;
        imgData.data[i * 4 + 1] = val;
        imgData.data[i * 4 + 2] = val;
        imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);

    return traceCanvasWithPotrace(canvas);
};

// Dedicated Vintage Processor: Luminance based, no color logic
const processVintageVector = (ctx: CanvasRenderingContext2D, width: number, height: number, config: ProcessingConfig): { layers: VectorLayer[], svgPaths: string } => {
    // DIRECT PASSTHROUGH: No manual thresholding loops.
    // We let Potrace handle the thresholding internally via its loadBm logic.
    const contours = traceCanvasWithPotrace(ctx.canvas);

    const pixelsPerMm = PROCESS_WIDTH / config.widthMm;
    const cx = width / 2;
    const cy = height / 2;

    // Scale & Optimize
    let pathsMm = contours.map(path => path.map(p => ({ x: (p.x - cx) / pixelsPerMm, y: (cy - p.y) / pixelsPerMm })));
    const epsilon = 0.05;
    pathsMm = pathsMm.map(path => simplifyPath(path, epsilon));
    pathsMm = optimizePathSequence(pathsMm);

    let svgPathStr = '';
    if (pathsMm.length > 0) {
        const pathD = pathsMm.map(path => {
            const pixels = path.map(p => ({ x: (p.x * pixelsPerMm) + cx, y: (-p.y * pixelsPerMm) + cy }));
            if (pixels.length < 2) return '';
            return `M ${pixels[0].x.toFixed(1)} ${pixels[0].y.toFixed(1)} ` + pixels.slice(1).map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        }).join(' ');
        // Vintage style SVG: Stroke only
        svgPathStr = `<path d="${pathD}" fill="none" stroke="#000000" stroke-width="2" />`;
    }

    return {
        layers: [{ color: '#000000', paths: pathsMm }],
        svgPaths: svgPathStr
    };
};

// Dedicated Patch Processor: Color segmentation based
const processPatchVectors = (ctx: CanvasRenderingContext2D, width: number, height: number, config: ProcessingConfig, img: HTMLImageElement): { layers: VectorLayer[], svgPaths: string, colors: string[] } => {
    let targetColors = [{ r: 0, g: 0, b: 0, hex: '#000000' }];
    if (config.colorCount > 1) {
        targetColors = extractDominantColors(ctx, width, height, config.colorCount);
    }
    targetColors.sort((a, b) => getLuminance(b.hex) - getLuminance(a.hex));

    const finalLayers: VectorLayer[] = [];
    const pixelsPerMm = PROCESS_WIDTH / config.widthMm;
    const cx = width / 2; const cy = height / 2;
    let svgPaths = '';

    for (const color of targetColors) {
        const binaryGrid = new Int8Array(width * height);
        const data = ctx.getImageData(0, 0, width, height).data;

        for (let k = 0; k < binaryGrid.length; k++) {
            const r = data[k * 4], g = data[k * 4 + 1], b = data[k * 4 + 2];
            if (colorDist(r, g, b, color.r, color.g, color.b) < 60 && data[k * 4 + 3] > 128) {
                binaryGrid[k] = 1;
            }
        }

        // Morphology for patches to close gaps
        let cleanGrid = morphologyOpen(binaryGrid, width, height, 1);

        const contours = traceBitmapWithPotrace(cleanGrid, width, height);

        let pathsMm = contours.map(path => path.map(p => ({ x: (p.x - cx) / pixelsPerMm, y: (cy - p.y) / pixelsPerMm })));
        const epsilon = 0.05;
        pathsMm = pathsMm.map(path => simplifyPath(path, epsilon));
        pathsMm = optimizePathSequence(pathsMm);

        if (pathsMm.length > 0) {
            finalLayers.push({ color: color.hex, paths: pathsMm });

            const pathD = pathsMm.map(path => {
                const pixels = path.map(p => ({ x: (p.x * pixelsPerMm) + cx, y: (-p.y * pixelsPerMm) + cy }));
                if (pixels.length < 2) return '';
                return `M ${pixels[0].x.toFixed(1)} ${pixels[0].y.toFixed(1)} ` + pixels.slice(1).map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z';
            }).join(' ');

            svgPaths += `<path d="${pathD}" fill="${color.hex}" stroke="none" />`;
        }
    }

    return {
        layers: finalLayers,
        svgPaths,
        colors: targetColors.map(c => c.hex)
    };
};

// PHASE 2: PREPARE VECTOR LAYERS (Router)
export const prepareVectorLayers = async (imageSrc: string, config: ProcessingConfig): Promise<{ layers: VectorLayer[], width: number, height: number, svgPreview: string, colors: string[] }> => {
    const img = await loadImage(imageSrc);
    const canvas = document.createElement('canvas');
    canvas.width = PROCESS_WIDTH;
    const scale = PROCESS_WIDTH / img.width;
    canvas.height = Math.floor(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Canvas context failed");

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let resultLayers: VectorLayer[] = [];
    let svgPaths = '';
    let finalColors: string[] = ['#000000'];

    if (config.designStyle === 'vintage') {
        const result = processVintageVector(ctx, canvas.width, canvas.height, config);
        resultLayers = result.layers;
        svgPaths = result.svgPaths;
    } else {
        const result = processPatchVectors(ctx, canvas.width, canvas.height, config, img);
        resultLayers = result.layers;
        svgPaths = result.svgPaths;
        finalColors = result.colors;
    }

    const svgPreview = `<svg viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg" style="background:white">${svgPaths}</svg>`;

    return {
        layers: resultLayers,
        width: config.widthMm,
        height: config.widthMm * (img.height / img.width),
        svgPreview,
        colors: finalColors
    };
};

// PHASE 3: DIGITIZE (Physics Engine Only)
export const digitizeDesign = (layers: VectorLayer[], config: ProcessingConfig): { stitches: Stitch[] } => {
    let allStitches: Stitch[] = [];

    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        let layerStitches: Stitch[] = [];

        for (const path of layer.paths) {
            // 1. UNDERLAY
            const underlay = generateUnderlay(path, config, i, layer.color);
            if (underlay.length > 0) {
                const tiedUnderlay = addTieIn(underlay);
                if (layerStitches.length > 0) {
                    layerStitches.push({ ...tiedUnderlay[0], type: 'jump', colorIndex: i, hexColor: layer.color, isStructure: true });
                }
                layerStitches.push(...tiedUnderlay);
            }

            // 2. MAIN STITCHES
            let main: Stitch[] = [];
            if (config.stitchType === 'tatami') {
                main = generateTatamiStitches([path], config, i, layer.color);
            } else if (config.stitchType === 'satin') {
                main = generateSatinStitches(path, config, i, layer.color);
            } else {
                main = generateRunningStitches(path, config, i, layer.color);
            }

            // 3. CLEANUP
            if (main.length > 0) {
                if (underlay.length === 0) main = addTieIn(main);
                main = addTieOff(main);

                if (layerStitches.length > 0) {
                    const last = layerStitches[layerStitches.length - 1];
                    const first = main[0];
                    const d = dist(last, first);

                    if (d > config.trimJumpDistanceMm) {
                        layerStitches.push({ ...last, type: 'trim', colorIndex: i, hexColor: layer.color, isStructure: true });
                        layerStitches.push({ ...first, type: 'jump', colorIndex: i, hexColor: layer.color, isStructure: true });
                    } else {
                        layerStitches.push({ ...first, type: 'jump', colorIndex: i, hexColor: layer.color, isStructure: true });
                    }
                }
                layerStitches.push(...main);
            }
        }

        if (layerStitches.length > 0) {
            if (allStitches.length > 0) {
                const last = allStitches[allStitches.length - 1];
                allStitches.push({ ...last, type: 'color_change', colorIndex: i, hexColor: layer.color, isStructure: true });
                allStitches.push({ ...layerStitches[0], type: 'jump', colorIndex: i, hexColor: layer.color, isStructure: true });
            }
            allStitches.push(...layerStitches);
        }
    }

    const cleanedStitches = removeSmallStitches(allStitches, config.minStitchLengthMm);

    if (cleanedStitches.length > 0) {
        cleanedStitches.push({ ...cleanedStitches[cleanedStitches.length - 1], type: 'end' });
    }

    return { stitches: cleanedStitches };
};