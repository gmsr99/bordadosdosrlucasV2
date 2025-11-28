
import { Stitch } from '../types';

/**
 * BERNINA / MELCO EXP FORMAT SPECIFICATION
 * 
 * - Coordinates: Relative, Signed 8-bit integers.
 * - Range: -127 to +127 (0.1mm units).
 * - Commands:
 *   - Stitch: dx, dy
 *   - Jump: 0x80, 0x04, dx, dy
 *   - Color Change (Stop): 0x80, 0x01, 0, 0
 *   - Trim: EXP doesn't have a specific Trim opcode universally. 
 *     Usually signaled by 3+ Jumps or a specific Jump sequence. 
 *     However, modern Berninas read Jump chains as Trims if configured.
 *   - End: No explicit opcode? PDF says "End of Design" required. 
 *     Usually implies a Stop or returning to origin. 
 *     Common practice: A final Stop command.
 */

export const createExpFile = (stitches: Stitch[]): Uint8Array => {
  const buffer = new Uint8Array(stitches.length * 8 + 1024);
  let offset = 0;
  let currentX = 0;
  let currentY = 0;

  const writeByte = (b: number) => { buffer[offset++] = b; };

  // Strict 8-bit signed limit (Safety margin 120)
  const MAX_STEP = 120;

  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i];

    // Handle Special Commands
    if (s.type === 'end') {
      // Force a Stop command as "End"
      // 0x80 0x01 0x00 0x00 (Color Change / Stop)
      writeByte(0x80); writeByte(0x01); writeByte(0x00); writeByte(0x00);
      continue;
    }

    if (s.type === 'color_change') {
      // Melco Stop
      writeByte(0x80); writeByte(0x01); writeByte(0x00); writeByte(0x00);
      continue;
    }

    if (s.type === 'trim') {
      // Explicit Trim Signal
      // Standard EXP Trim is often simulated by Jumps
      // 0x80 0x80 0x07 0x00 (Needle Up/Trim in some dialects)
      // Safer: A Jump sequence (3 jumps) usually triggers trim on Bernina/Melco.
      writeByte(0x80); writeByte(0x04); writeByte(0); writeByte(0);
      writeByte(0x80); writeByte(0x04); writeByte(0); writeByte(0);
      writeByte(0x80); writeByte(0x04); writeByte(0); writeByte(0);
      continue;
    }

    // Movement Logic (Anti-Drift)
    const targetX = Math.round(s.x * 10);
    const targetY = Math.round(s.y * 10);
    let dx = targetX - currentX;
    let dy = targetY - currentY;

    // Split Jumps/Stitches
    while (dx !== 0 || dy !== 0) {
      let stepX = dx;
      let stepY = dy;

      // Clamp
      if (stepX > MAX_STEP) stepX = MAX_STEP;
      if (stepX < -MAX_STEP) stepX = -MAX_STEP;
      if (stepY > MAX_STEP) stepY = MAX_STEP;
      if (stepY < -MAX_STEP) stepY = -MAX_STEP;

      // If s.type is Jump or we are splitting a long stitch (which becomes jump-like in physical move)
      // Actually, long stitches MUST be jumps if they exceed physical needle frame, 
      // but here 's' is already processed by physics engine to be safe length (stitch) or explicit jump.
      // If s.type == stitch and distance > MAX_STEP, it means the physics engine failed? 
      // No, physics engine caps at ~4mm or 7mm. 7mm = 70 units. 70 < 120. So pure stitches fit.
      // Jumps can be huge.

      if (s.type === 'jump') { // Trims handled above
        writeByte(0x80); writeByte(0x04); writeByte(stepX & 0xFF); writeByte(stepY & 0xFF);
      } else {
        // Normal Stitch
        writeByte(stepX & 0xFF); writeByte(stepY & 0xFF);
      }

      dx -= stepX;
      dy -= stepY;
      currentX += stepX;
      currentY += stepY;
    }
  }

  return buffer.slice(0, offset);
};

export const downloadBlob = (data: Uint8Array, filename: string) => {
  const blob = new Blob([data as any], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};