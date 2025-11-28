import { Stitch } from '../types';

/**
 * Encodes stitches into Tajima .DST Binary Format.
 * DST is the most widely used industrial embroidery format.
 * 
 * Structure:
 * - Header (512 bytes)
 * - Body (3 bytes per stitch command)
 */

// Helper: Bit manipulation for Tajima encoding
// Tajima encodes X and Y changes into 3 bytes using a specific bit interleaving pattern.
const encodeTajimaStitch = (dx: number, dy: number, type: 'stitch' | 'jump' | 'stop' | 'end') => {
    const b = new Uint8Array(3);
    let x = dx;
    let y = dy;
    let jump = type === 'jump';
    let stop = type === 'stop';
    let end = type === 'end';

    // Set Control Bits (Byte 2)
    // Bit 7 and 6 are status bits
    // 00 = Normal, 11 = Jump or Stop (distinguished by other bits usually, but DST is weird)
    // Standard DST: 
    // Jump: Set bit 7 of byte 2.
    // Stop: Set bit 7 and 6 of byte 2.
    
    if (jump || stop || end) {
        b[2] |= 0b10000000; // Set bit 7 (Jump)
    }
    if (stop || end) {
        b[2] |= 0b01000000; // Set bit 6 (Stop/Color Change)
    }

    // Map bits for Y
    if (y >= 1) { b[0] |= 0x01; y -= 1; }
    if (y <= -1) { b[0] |= 0x02; y += 1; }
    if (y >= 9) { b[0] |= 0x04; y -= 9; }
    if (y <= -9) { b[0] |= 0x08; y += 9; }
    if (y >= 3) { b[1] |= 0x80; y -= 3; }
    if (y <= -3) { b[1] |= 0x40; y += 3; }
    if (y >= 27) { b[1] |= 0x20; y -= 27; }
    if (y <= -27) { b[1] |= 0x10; y += 27; }
    if (y >= 81) { b[2] |= 0x04; y -= 81; }
    if (y <= -81) { b[2] |= 0x08; y += 81; }

    // Map bits for X
    if (x >= 1) { b[0] |= 0x80; x -= 1; }
    if (x <= -1) { b[0] |= 0x40; x += 1; }
    if (x >= 9) { b[0] |= 0x20; x -= 9; }
    if (x <= -9) { b[0] |= 0x10; x += 9; }
    if (x >= 3) { b[1] |= 0x08; x -= 3; }
    if (x <= -3) { b[1] |= 0x04; x += 3; }
    if (x >= 27) { b[1] |= 0x02; x -= 27; }
    if (x <= -27) { b[1] |= 0x01; x += 27; }
    if (x >= 81) { b[2] |= 0x10; x -= 81; }
    if (x <= -81) { b[2] |= 0x20; x += 81; }

    return b;
};

export const createDstFile = (stitches: Stitch[], widthMm: number, heightMm: number): Uint8Array => {
    // 1. Calculate Extents and convert to 0.1mm integers
    // DST coordinates are relative, but header needs absolute bounding box in 0.1mm
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let currentX = 0, currentY = 0;
    let stitchCount = 0;

    // Buffer for body
    const bodyParts: Uint8Array[] = [];

    const MAX_STEP = 121; // Tajima limit is strictly 121 units (approx 12.1mm)

    for (let i = 0; i < stitches.length; i++) {
        const s = stitches[i];
        
        // Skip end command in loop, we handle it manually at end
        if (s.type === 'end') continue;

        // Target in 0.1mm
        const targetX = Math.round(s.x * 10);
        const targetY = Math.round(s.y * 10);

        // Delta
        let dx = targetX - currentX;
        let dy = targetY - currentY;

        // Bounds check based on absolute
        if (targetX < minX) minX = targetX;
        if (targetX > maxX) maxX = targetX;
        if (targetY < minY) minY = targetY;
        if (targetY > maxY) maxY = targetY;

        // Handle jumps larger than 121 units
        while (Math.abs(dx) > MAX_STEP || Math.abs(dy) > MAX_STEP) {
            let stepX = dx > MAX_STEP ? MAX_STEP : (dx < -MAX_STEP ? -MAX_STEP : dx);
            let stepY = dy > MAX_STEP ? MAX_STEP : (dy < -MAX_STEP ? -MAX_STEP : dy);

            // Force JUMP code for intermediate steps
            bodyParts.push(encodeTajimaStitch(stepX, stepY, 'jump'));
            
            dx -= stepX;
            dy -= stepY;
            currentX += stepX;
            currentY += stepY;
            stitchCount++; // Does intermediate jump count as stitch? In DST usually yes.
        }

        // Final step
        let type: 'stitch' | 'jump' | 'stop' = 'stitch';
        if (s.type === 'jump') type = 'jump';
        if (s.type === 'color_change') type = 'stop';

        bodyParts.push(encodeTajimaStitch(dx, dy, type));
        
        currentX += dx;
        currentY += dy;
        stitchCount++;
    }

    // End of file command
    bodyParts.push(encodeTajimaStitch(0, 0, 'end'));

    // 2. Build Header (512 Bytes)
    const header = new Uint8Array(512).fill(32); // Fill with spaces (ASCII 32)

    const writeString = (str: string, offset: number) => {
        for (let i = 0; i < str.length; i++) {
            header[offset + i] = str.charCodeAt(i);
        }
    };

    // Construct Label (LA)
    const label = "SR_LUCAS"; 
    writeString(`LA:${label.padEnd(16, ' ')}`, 0);

    // Stitch Count (ST) - 7 digits
    writeString(`ST:${stitchCount.toString().padStart(7, '0')}`, 23);

    // Color Change Count (CO) - 3 digits (Currently 0 or 1 based on logic)
    // For now we just count explicitly
    const coCount = stitches.filter(s => s.type === 'color_change').length;
    writeString(`CO:${coCount.toString().padStart(3, '0')}`, 39);

    // Extents (+X, -X, +Y, -Y) - 5 digits
    // DST coordinates center is roughly user defined, but usually 0,0 is center.
    // Our stitches are centered at 0,0.
    // +X is max positive X distance from 0.
    const pX = Math.max(0, maxX);
    const nX = Math.abs(Math.min(0, minX));
    const pY = Math.max(0, maxY);
    const nY = Math.abs(Math.min(0, minY));

    writeString(`+X:${pX.toString().padStart(5, '0')}`, 54);
    writeString(`-X:${nX.toString().padStart(5, '0')}`, 69);
    writeString(`+Y:${pY.toString().padStart(5, '0')}`, 84);
    writeString(`-Y:${nY.toString().padStart(5, '0')}`, 99);

    // Author/Copyright (AX, AY, MX, MY usually implied delta to last point, or 0)
    writeString("AX:+00000", 114);
    writeString("AY:+00000", 129);
    writeString("MX:+00000", 144);
    writeString("MY:+00000", 159);

    // PD (Previous Design? Usually emulated 000000)
    writeString("PD:******", 174); // Often ******* or 000000

    // 0x1A (EOF for header) usually at byte 511? DST doesn't strictly enforce it but good practice.
    
    // 3. Combine Header and Body
    const totalSize = 512 + bodyParts.length * 3;
    const finalBuffer = new Uint8Array(totalSize);
    
    finalBuffer.set(header, 0);
    
    let offset = 512;
    for (const part of bodyParts) {
        finalBuffer.set(part, offset);
        offset += 3;
    }

    return finalBuffer;
};