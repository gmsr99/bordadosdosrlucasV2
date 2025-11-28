declare module 'svg-path-parser' {
    export interface Command {
        code: string;
        command: string;
        x: number;
        y: number;
        x1?: number;
        y1?: number;
        x2?: number;
        y2?: number;
        relative?: boolean;
    }
    export function parseSVG(d: string): Command[];
    export function makeAbsolute(commands: Command[]): Command[];
}
