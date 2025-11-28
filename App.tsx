'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Upload, Zap, Download, RefreshCw, Scissors, ArrowRight, Plus, ChevronRight, Settings2, X, PenTool, PaintBucket, Highlighter, Scan, GripHorizontal, Layers, Activity, CheckCircle, RotateCcw, FileCode, Ruler, Maximize2 } from 'lucide-react';
import { AppState, Stitch, StitchType, ProcessingConfig, DesignStyle, Hoop, VectorLayer } from './types';
import { simplifyImageWithAI } from './services/geminiService';
import { prepareVectorLayers, digitizeDesign } from './services/imageProcessor';
import { createExpFile, downloadBlob } from './services/expExporter';
import { createDstFile } from './services/dstExporter';
import Preview from './components/Preview';

const HOOPS: Hoop[] = [
    { name: '100x100 (4x4")', width: 100, height: 100, shape: 'rect' },
    { name: '130x180 (5x7")', width: 130, height: 180, shape: 'rect' },
    { name: '160x260 (6x10")', width: 160, height: 260, shape: 'rect' },
    { name: 'Bernina Large Oval', width: 145, height: 255, shape: 'oval' },
    { name: 'Bernina Midi', width: 100, height: 130, shape: 'rect' },
];

const App: React.FC = () => {
    const [state, setState] = useState<AppState>(AppState.IDLE);

    // Data State
    const [originalImage, setOriginalImage] = useState<string | null>(null);
    const [processedImage, setProcessedImage] = useState<string | null>(null); // Bitmap (Gemini)
    const [vectorLayers, setVectorLayers] = useState<VectorLayer[]>([]); // Geometry (Potrace)
    const [svgPreview, setSvgPreview] = useState<string | null>(null);
    const [stitches, setStitches] = useState<Stitch[]>([]);
    const [designDims, setDesignDims] = useState<{ width: number; height: number }>({ width: 100, height: 100 });
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // UI State
    const [isMobileSettingsOpen, setIsMobileSettingsOpen] = useState(false);

    // --- CONFIGURATION STATE ---
    const [designStyle, setDesignStyle] = useState<DesignStyle>('patch_fill');
    const [targetWidth, setTargetWidth] = useState(100);
    const [colorCount, setColorCount] = useState(4);
    const [selectedHoop, setSelectedHoop] = useState<Hoop>(HOOPS[0]);
    const [exportFormat, setExportFormat] = useState<'exp' | 'dst'>('exp');

    // --- ENGINEERING PARAMS ---
    const [stitchType, setStitchType] = useState<StitchType>('tatami');
    const [density, setDensity] = useState(0.40);
    const [pullComp, setPullComp] = useState(0.25);
    const [enableUnderlay, setEnableUnderlay] = useState(true);
    const [satinWidth, setSatinWidth] = useState(3.5);
    const [tatamiAngle, setTatamiAngle] = useState(45);
    const [trimJump, setTrimJump] = useState(2.0);
    const [stitchLength, setStitchLength] = useState(2.5); // New Parameter

    const handleMainStyleSelect = (category: 'vintage' | 'patch') => {
        if (category === 'vintage') {
            setDesignStyle('vintage');
            setStitchType('running');
            setColorCount(1);
            setSatinWidth(2.5);
            setPullComp(0.1);
            setStitchLength(2.5);
        } else {
            setDesignStyle('patch_fill');
            setStitchType('tatami');
            setColorCount(4);
            setPullComp(0.3);
            setStitchLength(7.0); // Tatami default split
        }
    };

    const handlePatchSubModeSelect = (mode: 'lines' | 'fill') => {
        if (mode === 'lines') {
            setDesignStyle('patch_line');
            setStitchType('satin');
            setColorCount(1);
            setSatinWidth(3.0);
            setStitchLength(7.0);
        } else {
            setDesignStyle('patch_fill');
            setStitchType('tatami');
            setColorCount(4);
            setStitchLength(7.0);
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                setOriginalImage(evt.target?.result as string);
                setProcessedImage(null);
                setVectorLayers([]);
                setStitches([]);
                setState(AppState.IDLE);
            };
            reader.readAsDataURL(file);
        }
    };

    // STEP 1: VISION (Bitmap Analysis)
    const handleAnalyze = async () => {
        if (!originalImage) return;
        try {
            setState(AppState.ANALYZING);
            setErrorMsg(null);
            const aiBitmap = await simplifyImageWithAI(originalImage, "", colorCount, designStyle);
            setProcessedImage(aiBitmap);
            setState(AppState.REVIEW_BITMAP);
        } catch (err: any) {
            setErrorMsg(err.message || "Vision Error");
            setState(AppState.ERROR);
        }
    };

    // STEP 2: VECTORIZE (Potrace Geometry)
    const handleVectorize = async () => {
        if (!processedImage) return;
        try {
            setState(AppState.VECTORIZING);
            const config: ProcessingConfig = {
                designStyle, widthMm: targetWidth, stitchType, densityMm: density, satinColumnWidthMm: satinWidth,
                pullCompensationMm: pullComp, enableUnderlay, tatamiAngle, colorCount, maxStitchLengthMm: stitchLength,
                minStitchLengthMm: 0.3, trimJumpDistanceMm: trimJump
            };

            const result = await prepareVectorLayers(processedImage, config);
            setVectorLayers(result.layers);
            setSvgPreview(result.svgPreview);
            setDesignDims({ width: result.width, height: result.height });
            setState(AppState.REVIEW_VECTORS);
        } catch (err: any) {
            setErrorMsg("Vectorization Error: " + err.message);
            setState(AppState.ERROR);
        }
    };

    // STEP 3: DIGITIZE (Physics Engine)
    const handleDigitize = useCallback(() => {
        if (vectorLayers.length === 0) return;
        try {
            setState(AppState.DIGITIZING);
            const config: ProcessingConfig = {
                designStyle, widthMm: targetWidth, stitchType, densityMm: density, satinColumnWidthMm: satinWidth,
                pullCompensationMm: pullComp, enableUnderlay, tatamiAngle, colorCount, maxStitchLengthMm: stitchLength,
                minStitchLengthMm: designStyle === 'vintage' ? 0.1 : 0.3, trimJumpDistanceMm: trimJump
            };

            // Slight delay to allow UI to show loading state
            setTimeout(() => {
                const result = digitizeDesign(vectorLayers, config);
                setStitches(result.stitches);
                setState(AppState.PREVIEW);
            }, 50);
        } catch (err: any) {
            setErrorMsg("Physics Error: " + err.message);
            setState(AppState.ERROR);
        }
    }, [vectorLayers, designStyle, targetWidth, stitchType, density, satinWidth, pullComp, enableUnderlay, tatamiAngle, trimJump, stitchLength]);

    // LIVE UPDATE: When in preview, if params change, re-run Physics only
    useEffect(() => {
        if (state === AppState.PREVIEW) {
            const timer = setTimeout(() => {
                handleDigitize();
            }, 200); // Debounce
            return () => clearTimeout(timer);
        }
    }, [density, pullComp, trimJump, satinWidth, tatamiAngle, enableUnderlay, stitchLength]);

    const handleDownload = () => {
        if (stitches.length === 0) return;
        if (exportFormat === 'exp') {
            const data = createExpFile(stitches);
            downloadBlob(data, 'design_bernia_srlucas.exp');
        } else {
            const data = createDstFile(stitches, designDims.width, designDims.height);
            downloadBlob(data, 'design_bernia_srlucas.dst');
        }
    };

    const handleReset = () => {
        setOriginalImage(null);
        setProcessedImage(null);
        setVectorLayers([]);
        setStitches([]);
        setState(AppState.IDLE);
    };

    const isVintage = designStyle === 'vintage';
    const isPatch = designStyle === 'patch_line' || designStyle === 'patch_fill';

    return (
        <div className="flex flex-col md:flex-row h-screen w-full bg-[#FDFBF7] text-[#1C1C1C] overflow-hidden">

            <main className="flex-1 flex flex-col relative h-full overflow-hidden">
                {/* Header */}
                <div className="absolute top-0 left-0 w-full p-6 flex justify-between z-20 pointer-events-none">
                    <div onClick={handleReset} className="pointer-events-auto cursor-pointer flex items-center gap-3">
                        <div className="w-10 h-10 bg-[#1C1C1C] rounded-lg flex items-center justify-center text-white font-serif font-bold text-xl">L</div>
                        <div>
                            <h1 className="font-serif font-bold text-lg">Sr. Lucas</h1>
                            <p className="text-[10px] uppercase tracking-widest text-[#2A4F60] font-bold">Atelier Digital</p>
                        </div>
                    </div>

                    {state !== AppState.IDLE && (
                        <div className="pointer-events-auto flex items-center gap-2 bg-white/80 backdrop-blur border border-neutral-200 px-3 py-1.5 rounded-full text-xs font-medium text-neutral-500 shadow-sm">
                            <span className={state === AppState.REVIEW_BITMAP ? "text-[#2A4F60] font-bold" : ""}>1. Visão</span>
                            <ChevronRight size={12} />
                            <span className={state === AppState.REVIEW_VECTORS ? "text-[#2A4F60] font-bold" : ""}>2. Vetor</span>
                            <ChevronRight size={12} />
                            <span className={state === AppState.PREVIEW ? "text-[#2A4F60] font-bold" : ""}>3. Bordado</span>
                        </div>
                    )}
                </div>

                {/* Stage Content */}
                <div className="flex-1 flex items-center justify-center bg-[#FDFBF7] relative p-4">
                    <div className="absolute inset-0 opacity-5" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>

                    {/* 0. IDLE (Upload) */}
                    {!originalImage && (
                        <div className="text-center space-y-4 animate-fade-in z-10">
                            <div className="w-20 h-20 bg-white border-2 border-dashed border-[#D8B066] rounded-2xl mx-auto flex items-center justify-center">
                                <Plus className="text-[#D8B066]" />
                            </div>
                            <h2 className="font-serif text-2xl text-[#2A4F60]">Nova Criação</h2>
                            <p className="text-sm text-neutral-500 max-w-xs mx-auto">Carregue uma imagem para iniciar o pipeline de engenharia de bordado.</p>
                            <label className="inline-flex items-center gap-2 bg-[#1C1C1C] text-white px-6 py-3 rounded-xl font-medium cursor-pointer shadow-lg hover:bg-[#333] transition-colors">
                                <Upload size={18} /> Carregar Imagem
                                <input type="file" onChange={handleFileUpload} className="hidden" accept="image/*" />
                            </label>
                        </div>
                    )}

                    {/* 1. REVIEW BITMAP (Gemini Output) */}
                    {originalImage && (state === AppState.IDLE || state === AppState.ANALYZING || state === AppState.REVIEW_BITMAP) && (
                        <div className="relative max-w-4xl w-full h-[70vh] flex gap-4">
                            {/* Original */}
                            <div className="flex-1 bg-white p-2 rounded-xl border border-neutral-200 shadow-lg relative flex flex-col">
                                <span className="absolute top-4 left-4 bg-black/50 text-white text-xs px-2 py-1 rounded backdrop-blur">Original</span>
                                <img src={originalImage} className="w-full h-full object-contain rounded-lg" />
                            </div>

                            {/* Processed (or Loading) */}
                            <div className="flex-1 bg-white p-2 rounded-xl border border-neutral-200 shadow-lg relative flex flex-col items-center justify-center">
                                <span className="absolute top-4 left-4 bg-[#2A4F60] text-white text-xs px-2 py-1 rounded backdrop-blur">IA Vision</span>

                                {state === AppState.ANALYZING ? (
                                    <div className="text-center">
                                        <div className="w-10 h-10 border-4 border-[#2A4F60] border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                                        <p className="text-sm font-medium text-[#2A4F60]">A Otimizar Imagem...</p>
                                    </div>
                                ) : processedImage ? (
                                    <img src={processedImage} className="w-full h-full object-contain rounded-lg pixelated" style={{ imageRendering: 'pixelated' }} />
                                ) : (
                                    <div className="text-center text-neutral-400">
                                        <Scan size={48} className="mx-auto mb-2 opacity-50" />
                                        <p className="text-sm">A aguardar análise</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* 2. REVIEW VECTORS (Potrace Output) */}
                    {(state === AppState.VECTORIZING || state === AppState.REVIEW_VECTORS) && (
                        <div className="relative max-w-2xl w-full h-[70vh] bg-white p-2 rounded-xl border border-neutral-200 shadow-lg flex flex-col items-center justify-center">
                            <span className="absolute top-4 left-4 bg-[#D8B066] text-white text-xs px-2 py-1 rounded backdrop-blur">Geometria Vetorial</span>
                            {state === AppState.VECTORIZING ? (
                                <div className="text-center">
                                    <div className="w-10 h-10 border-4 border-[#D8B066] border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                                    <p className="text-sm font-medium text-[#D8B066]">A Vetorizar...</p>
                                </div>
                            ) : svgPreview && (
                                <div className="w-full h-full flex items-center justify-center p-8" dangerouslySetInnerHTML={{ __html: svgPreview }} />
                            )}
                        </div>
                    )}

                    {/* 3. PREVIEW (Final Embroidery) */}
                    {(state === AppState.DIGITIZING || state === AppState.PREVIEW) && (
                        <div className="w-full h-full max-w-4xl max-h-[80vh] relative">
                            {state === AppState.DIGITIZING && (
                                <div className="absolute inset-0 z-50 bg-white/50 backdrop-blur-sm flex items-center justify-center rounded-xl">
                                    <div className="bg-white px-6 py-4 rounded-xl shadow-xl border border-neutral-100 flex items-center gap-3">
                                        <div className="w-5 h-5 border-2 border-[#2A4F60] border-t-transparent rounded-full animate-spin"></div>
                                        <span className="text-sm font-medium text-[#2A4F60]">A Calcular Física...</span>
                                    </div>
                                </div>
                            )}
                            <Preview
                                stitches={stitches}
                                widthMm={designDims.width}
                                heightMm={designDims.height}
                                hoop={selectedHoop}
                                className="h-full shadow-2xl border border-[#E8E6E2]"
                            />
                        </div>
                    )}
                </div>
            </main>

            {/* Sidebar Controls (Context Aware) */}
            <aside className={`fixed md:relative bottom-0 right-0 w-full md:w-96 bg-white border-l border-[#E8E6E2] shadow-2xl md:shadow-none transition-transform duration-300 z-30 flex flex-col h-[85vh] md:h-screen rounded-t-3xl md:rounded-none ${isMobileSettingsOpen || window.innerWidth >= 768 ? 'translate-y-0' : 'translate-y-full'}`}>

                <div className="p-6 border-b border-[#E8E6E2] flex justify-between items-center md:hidden">
                    <h3 className="font-serif font-bold">Painel de Controlo</h3>
                    <button onClick={() => setIsMobileSettingsOpen(false)}><X /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8">

                    {/* STAGE 1 CONTROLS */}
                    {(state === AppState.IDLE || state === AppState.ANALYZING || state === AppState.REVIEW_BITMAP) && (
                        <section className="animate-fade-in">
                            <h4 className="text-[10px] font-bold text-[#2A4F60] uppercase tracking-[0.2em] mb-4">1. Estilo & Visão</h4>
                            <div className="grid grid-cols-2 gap-3 mb-4">
                                <button onClick={() => handleMainStyleSelect('vintage')} className={`p-3 rounded-xl border text-sm flex flex-col items-center gap-2 ${isVintage ? 'border-[#2A4F60] bg-[#2A4F60]/5 text-[#2A4F60]' : 'border-neutral-200 text-neutral-400'}`}>
                                    <PenTool size={18} /> Vintage
                                </button>
                                <button onClick={() => handleMainStyleSelect('patch')} className={`p-3 rounded-xl border text-sm flex flex-col items-center gap-2 ${isPatch ? 'border-[#2A4F60] bg-[#2A4F60]/5 text-[#2A4F60]' : 'border-neutral-200 text-neutral-400'}`}>
                                    <Layers size={18} /> Patch
                                </button>
                            </div>
                            {isPatch && (
                                <div className="bg-neutral-50 p-1 rounded-lg flex mb-4 border border-neutral-200">
                                    <button onClick={() => handlePatchSubModeSelect('lines')} className={`flex-1 py-1.5 text-xs font-medium rounded ${designStyle === 'patch_line' ? 'bg-white shadow text-[#2A4F60]' : 'text-neutral-400'}`}>Traços</button>
                                    <button onClick={() => handlePatchSubModeSelect('fill')} className={`flex-1 py-1.5 text-xs font-medium rounded ${designStyle === 'patch_fill' ? 'bg-white shadow text-[#2A4F60]' : 'text-neutral-400'}`}>Preenchimento</button>
                                </div>
                            )}
                            {designStyle === 'patch_fill' && (
                                <div className="flex items-center justify-between">
                                    <label className="text-sm font-medium">Cores</label>
                                    <div className="flex items-center gap-3">
                                        <input type="range" min="2" max="8" value={colorCount} onChange={(e) => setColorCount(Number(e.target.value))} className="w-24 h-1 bg-neutral-200 rounded-full accent-[#2A4F60]" />
                                        <span className="text-xs font-mono w-4">{colorCount}</span>
                                    </div>
                                </div>
                            )}

                            <div className="mt-8 pt-6 border-t border-dashed border-neutral-200">
                                {state === AppState.REVIEW_BITMAP ? (
                                    <div className="flex flex-col gap-3">
                                        <button onClick={handleAnalyze} className="w-full py-3 bg-neutral-100 text-neutral-600 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-neutral-200 transition-colors">
                                            <RotateCcw size={16} /> Tentar Novamente
                                        </button>
                                        <button onClick={handleVectorize} className="w-full py-3 bg-[#1C1C1C] text-white rounded-xl font-medium shadow-lg hover:bg-black flex items-center justify-center gap-2">
                                            Vetorizar <ArrowRight size={16} />
                                        </button>
                                    </div>
                                ) : (
                                    <button onClick={handleAnalyze} disabled={!originalImage || state === AppState.ANALYZING} className="w-full py-3 bg-[#1C1C1C] text-white rounded-xl font-medium shadow-lg hover:bg-black disabled:opacity-50 flex items-center justify-center gap-2">
                                        <Zap size={18} /> {state === AppState.ANALYZING ? 'A Processar...' : 'Analisar Imagem'}
                                    </button>
                                )}
                            </div>
                        </section>
                    )}

                    {/* STAGE 2 CONTROLS */}
                    {(state === AppState.VECTORIZING || state === AppState.REVIEW_VECTORS) && (
                        <section className="animate-fade-in">
                            <h4 className="text-[10px] font-bold text-[#D8B066] uppercase tracking-[0.2em] mb-4">2. Geometria</h4>
                            <p className="text-xs text-neutral-500 mb-6">
                                Os contornos foram extraídos matematicamente. Verifique a qualidade das linhas antes de aplicar os pontos.
                            </p>
                            <div className="flex flex-col gap-3">
                                <button onClick={() => setState(AppState.REVIEW_BITMAP)} className="w-full py-3 bg-white border border-neutral-200 text-neutral-600 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-neutral-50 transition-colors">
                                    Voltar
                                </button>
                                <button onClick={handleDigitize} className="w-full py-3 bg-[#2A4F60] text-white rounded-xl font-medium shadow-lg hover:bg-[#1e3a47] flex items-center justify-center gap-2">
                                    Digitalizar (Bordar) <Activity size={18} />
                                </button>
                            </div>
                        </section>
                    )}

                    {/* STAGE 3 CONTROLS (Physics) */}
                    {(state === AppState.DIGITIZING || state === AppState.PREVIEW) && (
                        <section className="animate-fade-in">
                            <h4 className="text-[10px] font-bold text-[#2A4F60] uppercase tracking-[0.2em] mb-4">3. Física & Acabamento</h4>

                            <div className="space-y-5">
                                <div>
                                    <label className="text-xs font-semibold text-neutral-500 mb-1.5 block">Bastidor</label>
                                    <select value={selectedHoop.name} onChange={(e) => setSelectedHoop(HOOPS.find(h => h.name === e.target.value) || HOOPS[0])} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg h-10 px-3 text-sm">
                                        {HOOPS.map(h => <option key={h.name} value={h.name}>{h.name}</option>)}
                                    </select>
                                </div>

                                <div>
                                    <label className="text-xs font-semibold text-neutral-500 mb-1.5 block">Tipo de Ponto</label>
                                    <div className="flex gap-2">
                                        {['running', 'satin', 'tatami'].map(t => (
                                            <button key={t} onClick={() => setStitchType(t as StitchType)} className={`px-3 py-1.5 rounded-lg border text-xs capitalize ${stitchType === t ? 'border-[#2A4F60] text-[#2A4F60] bg-[#2A4F60]/5' : 'border-neutral-200 text-neutral-500'}`}>
                                                {t}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-4 pt-2">
                                    {/* Sliders visibility logic */}

                                    {/* STITCH LENGTH (Running: Stitch Len, Satin/Tatami: Max/Split Len) */}
                                    <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium flex items-center gap-1"><Ruler size={12} /> {stitchType === 'running' ? 'Comp. Ponto' : 'Split / Max'}</label>
                                        <span className="text-[10px] font-mono bg-neutral-100 px-1 rounded">{stitchLength}mm</span>
                                    </div>
                                    <input type="range" min="1.0" max="12.0" step="0.5" value={stitchLength} onChange={(e) => setStitchLength(Number(e.target.value))} className="w-full h-1 bg-neutral-200 rounded-full accent-[#2A4F60]" />

                                    {/* DENSITY (Only for Satin/Tatami) */}
                                    {stitchType !== 'running' && (
                                        <>
                                            <div className="flex justify-between items-center">
                                                <label className="text-xs font-medium flex items-center gap-1"><Scan size={12} /> Densidade (mm)</label>
                                                <span className="text-[10px] font-mono bg-neutral-100 px-1 rounded">{density}</span>
                                            </div>
                                            <input type="range" min="0.3" max="1.0" step="0.05" value={density} onChange={(e) => setDensity(Number(e.target.value))} className="w-full h-1 bg-neutral-200 rounded-full accent-[#2A4F60]" />
                                        </>
                                    )}

                                    {/* SATIN WIDTH (Only for Satin) */}
                                    {stitchType === 'satin' && (
                                        <>
                                            <div className="flex justify-between items-center">
                                                <label className="text-xs font-medium flex items-center gap-1"><Maximize2 size={12} /> Largura Coluna</label>
                                                <span className="text-[10px] font-mono bg-neutral-100 px-1 rounded">{satinWidth}mm</span>
                                            </div>
                                            <input type="range" min="1.0" max="8.0" step="0.5" value={satinWidth} onChange={(e) => setSatinWidth(Number(e.target.value))} className="w-full h-1 bg-neutral-200 rounded-full accent-[#2A4F60]" />
                                        </>
                                    )}

                                    {/* PULL COMP (Relevant for Satin/Tatami, less for Running but still there) */}
                                    <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium flex items-center gap-1"><GripHorizontal size={12} /> Compensação (Pull)</label>
                                        <span className="text-[10px] font-mono bg-neutral-100 px-1 rounded">{pullComp}mm</span>
                                    </div>
                                    <input type="range" min="0.0" max="0.6" step="0.05" value={pullComp} onChange={(e) => setPullComp(Number(e.target.value))} className="w-full h-1 bg-neutral-200 rounded-full accent-[#2A4F60]" />

                                    <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium flex items-center gap-1"><Scissors size={12} /> Trim Threshold</label>
                                        <span className="text-[10px] font-mono bg-neutral-100 px-1 rounded">{trimJump}mm</span>
                                    </div>
                                    <input type="range" min="1.0" max="10.0" step="0.5" value={trimJump} onChange={(e) => setTrimJump(Number(e.target.value))} className="w-full h-1 bg-neutral-200 rounded-full accent-[#2A4F60]" />

                                    <div className="flex items-center justify-between py-2 border-t border-dashed border-neutral-200">
                                        <span className="text-xs font-medium">Smart Underlay</span>
                                        <button onClick={() => setEnableUnderlay(!enableUnderlay)} className={`w-8 h-4 rounded-full transition-colors ${enableUnderlay ? 'bg-[#2A4F60]' : 'bg-neutral-300'} relative`}>
                                            <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-all ${enableUnderlay ? 'left-4' : 'left-0.5'}`}></div>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="mt-8 pt-6 border-t border-dashed border-neutral-200 flex flex-col gap-3">
                                <div className="flex gap-2">
                                    <button onClick={() => { setExportFormat('exp'); handleDownload(); }} className="flex-1 py-3 bg-[#1C1C1C] text-white rounded-xl font-medium shadow-lg hover:bg-black flex items-center justify-center gap-2">
                                        <Download size={18} /> EXP
                                    </button>
                                    <button onClick={() => { setExportFormat('dst'); handleDownload(); }} className="flex-1 py-3 bg-white border border-[#E8E6E2] text-[#1C1C1C] rounded-xl font-medium shadow-sm hover:bg-neutral-50 flex items-center justify-center gap-2">
                                        <FileCode size={18} /> DST
                                    </button>
                                </div>
                                <button onClick={() => setState(AppState.REVIEW_VECTORS)} className="w-full py-3 text-xs text-neutral-400 hover:text-neutral-600">
                                    Voltar à Geometria
                                </button>
                            </div>
                        </section>
                    )}

                    {errorMsg && <div className="bg-red-50 text-red-600 p-3 rounded-lg text-xs border border-red-100">{errorMsg}</div>}
                </div>
            </aside>

            {!isMobileSettingsOpen && originalImage && (
                <button onClick={() => setIsMobileSettingsOpen(true)} className="md:hidden fixed bottom-6 right-6 w-14 h-14 bg-[#1C1C1C] text-white rounded-full shadow-xl flex items-center justify-center z-40">
                    <Settings2 />
                </button>
            )}
        </div>
    );
};

export default App;
