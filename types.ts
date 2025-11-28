
export interface Point {
  x: number;
  y: number;
}

export interface Stitch extends Point {
  type: 'stitch' | 'jump' | 'color_change' | 'end' | 'trim';
  colorIndex?: number;
  hexColor?: string;
  isStructure?: boolean; // True for Underlay, Tie-ins, Tie-offs, Jumps
}

export enum AppState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING', // Gemini Vision -> Bitmap
  REVIEW_BITMAP = 'REVIEW_BITMAP', // User approves AI cleanup
  VECTORIZING = 'VECTORIZING', // Bitmap -> Potrace
  REVIEW_VECTORS = 'REVIEW_VECTORS', // User approves Geometry
  DIGITIZING = 'DIGITIZING', // Geometry -> Physics Engine
  PREVIEW = 'PREVIEW', // Final Hoop view
  ERROR = 'ERROR'
}

export interface VectorLayer {
  color: string;
  paths: Point[][]; // Coordinates in mm
}

export interface EmbroideryDesign {
  width: number;
  height: number;
  stitches: Stitch[];
  colors: string[];
}

export type DesignStyle = 'vintage' | 'patch_line' | 'patch_fill';
export type StitchType = 'running' | 'satin' | 'tatami';

export interface Hoop {
    name: string;
    width: number;
    height: number;
    shape: 'rect' | 'oval';
}

export interface ProcessingConfig {
  designStyle: DesignStyle; 
  widthMm: number;
  stitchType: StitchType;
  
  // --- Physics & Engineering (PDF Requirements) ---
  densityMm: number; // 0.38 - 0.42mm (Tatami standard)
  satinColumnWidthMm: number; 
  pullCompensationMm: number; // 0.2 - 0.4mm
  enableUnderlay: boolean; // Smart Underlay logic
  tatamiAngle: number;
  
  // --- Machine Limits & Quality ---
  maxStitchLengthMm: number; // 7mm (Satin) or 4mm (Tatami) before splitting
  minStitchLengthMm: number; // 0.3mm (Delete smaller)
  trimJumpDistanceMm: number; // > 2mm or 6mm -> TRIM
  
  colorCount: number;
}