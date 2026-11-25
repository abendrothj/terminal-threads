// The cell grid rarely fills the view exactly; the leftover strips take the colour of an edge
// cell so a full-screen program's own background reaches the edges (Ghostty's
// window-padding-color = extend). Works on xterm and headless cells alike.

export interface CellColor {
  isInverse(): number;
  isBgRGB(): boolean;
  isBgPalette(): boolean;
  getBgColor(): number;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
}

export interface Colors {
  ansi: string[]; // 16 theme colours
  background: string;
  foreground: string;
}

const rgb = (n: number) => `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;

// xterm's 256-colour table: 0-15 from the theme, a 6x6x6 cube, then 24 greys.
export function paletteColor(i: number, ansi: string[]): string {
  if (i < 16) return ansi[i] ?? '';
  if (i < 232) {
    const c = i - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(c / 36))}, ${level(Math.floor(c / 6) % 6)}, ${level(c % 6)})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g}, ${g}, ${g})`;
}

export function cellBackground(cell: CellColor, colors: Colors): string {
  const inverse = cell.isInverse() !== 0;
  const isRGB = inverse ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = inverse ? cell.isFgPalette() : cell.isBgPalette();
  const value = inverse ? cell.getFgColor() : cell.getBgColor();
  if (isRGB) return rgb(value);
  if (isPalette) return paletteColor(value, colors.ansi);
  return inverse ? colors.foreground : colors.background;
}
