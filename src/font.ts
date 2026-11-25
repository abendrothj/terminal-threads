export interface FontConfig {
  family: string;
  size: number;
  lineHeight: number;
}

export const FONT_KEYS = [
  'terminalThreads.fontSize',
  'terminal.integrated.fontSize',
  'editor.fontSize',
  'terminal.integrated.fontFamily',
  'editor.fontFamily',
  'terminal.integrated.lineHeight',
];

// Same precedence as VS Code's terminal, plus a size override for this view. No editor.lineHeight
// fallback: it is measured in pixels, the terminal's is a multiplier.
export function resolveFont(get: (key: string) => unknown): FontConfig {
  const num = (key: string) => {
    const v = get(key);
    return typeof v === 'number' && v > 0 ? v : undefined;
  };
  const str = (key: string) => {
    const v = get(key);
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  return {
    family: str('terminal.integrated.fontFamily') ?? str('editor.fontFamily') ?? 'monospace',
    size: num('terminalThreads.fontSize') ?? num('terminal.integrated.fontSize') ?? num('editor.fontSize') ?? 13,
    lineHeight: num('terminal.integrated.lineHeight') ?? 1,
  };
}
