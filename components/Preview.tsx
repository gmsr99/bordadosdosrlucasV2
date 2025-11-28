
import React, { useEffect, useRef, useState } from 'react';
import { Stitch, Hoop } from '../types';
import { Play, Pause, SkipBack, ZoomIn, ZoomOut, Move, Maximize, Eye, EyeOff } from 'lucide-react';

interface PreviewProps {
  stitches: Stitch[];
  widthMm: number;
  heightMm: number;
  color?: string;
  className?: string;
  hoop: Hoop; // Receive selected hoop from parent
}

const Preview: React.FC<PreviewProps> = ({ stitches, widthMm, heightMm, color = '#C44A4A', className, hoop }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Player State
  const [progressIndex, setProgressIndex] = useState<number>(stitches.length);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 5 | 10>(2);
  
  // Visualization State
  const [showStructure, setShowStructure] = useState(true);

  // Viewport State (Zoom & Pan)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // Reset when stitches change
  useEffect(() => {
    setProgressIndex(stitches.length);
    setIsPlaying(false);
  }, [stitches]);

  // Reset view when Hoop changes
  useEffect(() => {
      setZoom(1);
      setPan({ x: 0, y: 0 });
  }, [hoop.name]);

  // Animation Loop
  useEffect(() => {
    let animationFrame: number;
    
    if (isPlaying && progressIndex < stitches.length) {
        const animate = () => {
            setProgressIndex(prev => {
                const next = prev + speed;
                if (next >= stitches.length) {
                    setIsPlaying(false);
                    return stitches.length;
                }
                return next;
            });
            animationFrame = requestAnimationFrame(animate);
        };
        animationFrame = requestAnimationFrame(animate);
    }

    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, stitches.length, speed, progressIndex]);

  // --- Interactive Handlers (Mouse) ---

  const handleWheel = (e: React.WheelEvent) => {
    const scaleFactor = 1.1;
    const delta = e.deltaY > 0 ? 1 / scaleFactor : scaleFactor;
    const newZoom = Math.min(Math.max(zoom * delta, 0.5), 15); 
    setZoom(newZoom);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    
    setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // --- Interactive Handlers (Touch) ---

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsDragging(true);
      lastMousePos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - lastMousePos.current.x;
    const dy = e.touches[0].clientY - lastMousePos.current.y;
    
    setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    lastMousePos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  const handleResetView = () => {
      setZoom(1);
      setPan({ x: 0, y: 0 });
  };

  // --- Helper to draw rounded rect for hoops ---
  const drawRoundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
  };

  // --- Drawing Loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Dimensions based on container
    const padding = 60;
    const canvasWidth = container.offsetWidth || 800;
    const containerHeight = container.offsetHeight || 600; // Use actual height
    
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasWidth * dpr;
    canvas.height = containerHeight * dpr;
    
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    
    // 1. Draw Background (Machine Table)
    ctx.fillStyle = '#f0f0f0'; // Slightly darker than pure white to show hoop contrast
    ctx.fillRect(0, 0, canvasWidth, containerHeight);
    
    // Grid (Table surface)
    ctx.save();
    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gridSize = 40;
    for(let i=0; i<canvasWidth; i+=gridSize) { ctx.moveTo(i,0); ctx.lineTo(i,containerHeight); }
    for(let i=0; i<containerHeight; i+=gridSize) { ctx.moveTo(0,i); ctx.lineTo(canvasWidth,i); }
    ctx.stroke();
    ctx.restore();
    
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    
    // --- APPLY USER TRANSFORM (Zoom & Pan) ---
    const centerX = canvasWidth / 2;
    const centerY = containerHeight / 2;

    ctx.save(); 
    
    ctx.translate(centerX + pan.x, centerY + pan.y);
    ctx.scale(zoom, zoom);

    // --- CALCULATE SCALING ---
    const visibleW = Math.max(hoop.width, widthMm);
    const visibleH = Math.max(hoop.height, heightMm);

    const fitScaleX = (canvasWidth - padding * 2) / visibleW;
    const fitScaleY = (containerHeight - padding * 2) / visibleH;
    const baseScale = Math.min(fitScaleX, fitScaleY);
    
    // --- DRAW HOOP SIMULATOR ---
    const hw = hoop.width * baseScale;
    const hh = hoop.height * baseScale;
    const frameThick = 12 * baseScale / 10; // ~12mm visual thickness
    const cornerR = 20 * baseScale / 10;

    // Check Fit
    const fits = widthMm <= hoop.width && heightMm <= hoop.height;

    // Shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.2)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetY = 10;
    
    // Outer Frame
    ctx.fillStyle = '#e2e8f0'; 
    drawRoundedRect(ctx, -hw/2 - frameThick, -hh/2 - frameThick, hw + frameThick*2, hh + frameThick*2, cornerR + frameThick);
    ctx.fill();
    ctx.restore();

    // Screw Block
    ctx.fillStyle = '#cbd5e1'; 
    const screwW = 40 * baseScale / 10;
    const screwH = 15 * baseScale / 10;
    ctx.fillRect(-screwW/2, -hh/2 - frameThick - screwH, screwW, screwH);
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.arc(screwW/2 + 2, -hh/2 - frameThick - screwH/2, 4 * baseScale/10, 0, Math.PI*2);
    ctx.fill();

    // Inner Area
    ctx.fillStyle = '#FFFFFF'; 
    drawRoundedRect(ctx, -hw/2, -hh/2, hw, hh, cornerR);
    ctx.fill();
    
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2 / zoom;
    ctx.stroke();

    // Safety Area / Grid
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = fits ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.5)'; 
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([8 / zoom, 8 / zoom]);
    drawRoundedRect(ctx, -hw/2, -hh/2, hw, hh, cornerR);
    ctx.stroke();
    
    // Center Crosshairs
    ctx.beginPath();
    ctx.strokeStyle = fits ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([]); 
    ctx.moveTo(0, -hh/2); ctx.lineTo(0, hh/2);
    ctx.moveTo(-hw/2, 0); ctx.lineTo(hw/2, 0);
    ctx.stroke();
    ctx.restore();

    // Draw Design Bounding Box (Ghost) if it overflows
    if (!fits) {
        const dw = widthMm * baseScale;
        const dh = heightMm * baseScale;
        ctx.save();
        ctx.strokeStyle = '#ef4444'; // Red
        ctx.lineWidth = 1 / zoom;
        ctx.setLineDash([4/zoom, 4/zoom]);
        ctx.strokeRect(-dw/2, -dh/2, dw, dh);
        ctx.restore();
    }

    if (stitches.length === 0) {
        ctx.restore();
        return;
    }

    const visibleStitches = stitches.slice(0, progressIndex);

    // 4. Draw Stitches (Thread)
    
    let currentThreadColor = color;
    const fallbackColors = [color, '#2A4F60', '#D8B066', '#1C1C1C', '#5D5D5D']; 
    let colorIdx = 0;

    ctx.lineWidth = (0.4 * baseScale); 
    
    ctx.beginPath();
    ctx.strokeStyle = currentThreadColor;

    let isPathStarted = false;

    visibleStitches.forEach((s, i) => {
        const x = s.x * baseScale;
        const y = -s.y * baseScale;

        // Skip structural stitches if hidden
        if (s.isStructure && !showStructure) {
            // If we are skipping, we need to break current path to avoid drawing a line
            // from previous visible point to next visible point across the hidden structure.
            // Unless it's a jump, which is handled separately.
            ctx.stroke();
            ctx.beginPath();
            isPathStarted = false;
            return;
        }

        // Determine color for this segment
        // If it's structure, use RED. Otherwise use thread color.
        const segmentColor = s.isStructure ? '#EF4444' : (s.hexColor || currentThreadColor);
        
        // If color changed, stroke existing path and start new one
        if (ctx.strokeStyle !== segmentColor) {
             ctx.stroke();
             ctx.beginPath();
             ctx.strokeStyle = segmentColor;
             // If we are continuing a path but changing color (e.g. structure to normal),
             // we need to move to previous point? No, standard lineTo works if path is active.
             // But if we just started, we need moveTo.
             // Usually color changes happen at new stitches.
             // Let's ensure we are at the right spot.
             if (i > 0) {
                 const prev = visibleStitches[i-1];
                 ctx.moveTo(prev.x * baseScale, -prev.y * baseScale);
             }
        }

        // Update main thread color logic for non-structure
        if (!s.isStructure && s.hexColor && s.hexColor !== currentThreadColor) {
             currentThreadColor = s.hexColor;
        }

        if (i === 0 || !isPathStarted) {
            ctx.moveTo(x, y);
            isPathStarted = true;
        } else if (s.type === 'color_change') {
            ctx.stroke();
            
            if (!s.hexColor) {
                colorIdx = (colorIdx + 1) % fallbackColors.length;
                currentThreadColor = fallbackColors[colorIdx];
            }
            
            ctx.beginPath();
            ctx.strokeStyle = currentThreadColor; // Reset to thread color
            ctx.moveTo(x, y);
        } else if (s.type === 'jump') {
             ctx.stroke(); 
             
             // Draw jump line? Usually yes, if structure is shown
             if (showStructure) {
                 ctx.beginPath();
                 ctx.strokeStyle = '#EF4444'; // Jumps are structure
                 // Previous point
                 const prev = visibleStitches[i-1];
                 if (prev) ctx.moveTo(prev.x * baseScale, -prev.y * baseScale);
                 else ctx.moveTo(x,y);
                 ctx.lineTo(x,y);
                 ctx.stroke();
             }

             ctx.beginPath();
             ctx.strokeStyle = currentThreadColor;
             ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    ctx.stroke(); 

    // 5. Needle penetrations
    if (zoom > 1.5 && showStructure) {
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        const holeSize = (0.2 * baseScale);
        visibleStitches.forEach((s) => {
            if (s.type === 'stitch') {
                const x = s.x * baseScale;
                const y = -s.y * baseScale;
                if (!s.isStructure) {
                    ctx.beginPath();
                    ctx.arc(x, y, holeSize, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        });
    }

    // 6. Needle Position
    if (visibleStitches.length > 0 && progressIndex < stitches.length) {
        const last = visibleStitches[visibleStitches.length - 1];
        if (!last.isStructure || showStructure) {
            const lx = last.x * baseScale;
            const ly = -last.y * baseScale;
            const indicatorSize = 10 / zoom;

            ctx.strokeStyle = '#2A4F60';
            ctx.lineWidth = 2 / zoom;
            ctx.beginPath();
            ctx.moveTo(lx - indicatorSize, ly); ctx.lineTo(lx + indicatorSize, ly);
            ctx.moveTo(lx, ly - indicatorSize); ctx.lineTo(lx, ly + indicatorSize);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(lx, ly, indicatorSize * 0.6, 0, Math.PI * 2);
            ctx.strokeStyle = '#2A4F60';
            ctx.stroke();
        }
    }

    ctx.restore();

  }, [stitches, widthMm, heightMm, color, progressIndex, zoom, pan, hoop, showStructure]);

  const togglePlay = () => {
      if (progressIndex >= stitches.length) {
          setProgressIndex(0);
      }
      setIsPlaying(!isPlaying);
  };

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      setProgressIndex(val);
      setIsPlaying(false);
  };

  return (
    <div ref={containerRef} className={`relative w-full bg-white rounded-xl overflow-hidden group ${className} h-[500px] md:h-[600px]`}>
        
        {/* Hoop Selector Label */}
        <div className="absolute top-4 left-4 z-20 pointer-events-none">
             <div className={`px-3 py-1.5 rounded-lg shadow-sm border border-[#E8E6E2] text-xs font-mono font-medium backdrop-blur-md flex items-center gap-2 ${widthMm <= hoop.width && heightMm <= hoop.height ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                {hoop.name}
                {!(widthMm <= hoop.width && heightMm <= hoop.height) && <span className="font-bold">⚠️ OVERFLOW</span>}
             </div>
        </div>

        {/* Viewport Toolbar */}
        <div className="absolute top-4 right-4 flex flex-col gap-2 z-20">
            <div className="bg-white shadow-md border border-[#E8E6E2] rounded-lg flex flex-col overflow-hidden">
                <button onClick={() => setZoom(z => Math.min(z * 1.2, 15))} className="p-2 hover:bg-neutral-50 text-[#2A4F60] border-b border-[#E8E6E2]" title="Zoom In">
                    <ZoomIn size={18} />
                </button>
                <button onClick={handleResetView} className="p-2 hover:bg-neutral-50 text-[#2A4F60] border-b border-[#E8E6E2]" title="Fit to Hoop">
                    <Maximize size={18} />
                </button>
                <button onClick={() => setZoom(z => Math.max(z / 1.2, 0.5))} className="p-2 hover:bg-neutral-50 text-[#2A4F60]" title="Zoom Out">
                    <ZoomOut size={18} />
                </button>
            </div>
            
            <div className="bg-white shadow-md border border-[#E8E6E2] rounded-lg flex flex-col overflow-hidden">
                <button onClick={() => setShowStructure(!showStructure)} className={`p-2 hover:bg-neutral-50 ${showStructure ? 'text-[#EF4444]' : 'text-[#2A4F60]'} border-b border-[#E8E6E2]`} title="Toggle Structure">
                    {showStructure ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>
            </div>

            <div className={`bg-white shadow-md border border-[#E8E6E2] rounded-lg p-2 text-[#2A4F60] flex justify-center ${isDragging ? 'bg-[#2A4F60] text-white' : ''}`}>
                 <Move size={18} />
            </div>
        </div>

        <canvas 
            ref={canvasRef} 
            className={`w-full h-full relative z-10 touch-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        />
        
        {/* Player Controls */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[95%] md:w-[90%] max-w-md bg-white/90 backdrop-blur-md border border-[#E8E6E2] shadow-xl rounded-full px-4 py-2 md:px-6 md:py-3 z-20 flex items-center gap-3 md:gap-4 transition-opacity duration-300">
            <button 
                onClick={() => { setProgressIndex(0); setIsPlaying(false); }}
                className="text-[#2A4F60] hover:bg-neutral-100 p-1.5 rounded-full transition-colors"
                title="Reset"
            >
                <SkipBack size={18} fill="currentColor" />
            </button>

            <button 
                onClick={togglePlay}
                className="bg-[#2A4F60] text-white p-2 rounded-full hover:bg-[#224252] transition-colors shadow-md shrink-0"
            >
                {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
            </button>

            <div className="flex-1 flex flex-col justify-center">
                 <input 
                    type="range" 
                    min="0" 
                    max={stitches.length} 
                    value={progressIndex} 
                    onChange={handleSlider}
                    className="w-full h-1 bg-neutral-200 rounded-lg appearance-none cursor-pointer accent-[#C44A4A]"
                 />
            </div>

             <button 
                onClick={() => setSpeed(prev => prev === 10 ? 1 : prev === 1 ? 2 : prev === 2 ? 5 : 10)}
                className="text-xs font-mono font-bold text-[#2A4F60] w-8 text-center hover:bg-neutral-100 py-1 rounded"
                title="Speed"
            >
                {speed}x
            </button>
        </div>
    </div>
  );
};

export default Preview;