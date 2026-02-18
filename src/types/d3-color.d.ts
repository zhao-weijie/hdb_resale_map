declare module 'd3-color' {
    export interface RGBColor {
        r: number;
        g: number;
        b: number;
        opacity: number;
    }
    export function rgb(color: string): RGBColor;
}
