// ANSI 输出渲染视图：内部持有增量 AnsiParser，只解析新增分片，避免 256KB 长输出重复解析。
import { memo, useMemo, useRef, type CSSProperties } from 'react';
import { createAnsiParser, type AnsiLine, type AnsiParser, type AnsiStyle } from '../../core/terminalAnsi';
import { openInBrowserPanel } from '../browser/links';

export interface TerminalAnsiViewProps {
  output: string;
}

function spanStyle(s: AnsiStyle): CSSProperties | undefined {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    fg = s.bg ?? 'var(--term-bg)';
    bg = s.fg ?? 'var(--term-fg)';
  }
  const style: CSSProperties = {};
  let has = false;
  if (fg) { style.color = fg; has = true; }
  if (bg) { style.backgroundColor = bg; has = true; }
  if (s.bold) { style.fontWeight = 600; has = true; }
  if (s.dim) { style.opacity = 0.62; has = true; }
  if (s.italic) { style.fontStyle = 'italic'; has = true; }
  if (s.underline && s.strike) { style.textDecoration = 'underline line-through'; has = true; }
  else if (s.underline) { style.textDecoration = 'underline'; has = true; }
  else if (s.strike) { style.textDecoration = 'line-through'; has = true; }
  return has ? style : undefined;
}

const AnsiLineRow = memo(function AnsiLineRow({ line }: { line: AnsiLine }) {
  if (line.length === 0) {
    return <div className="cz-term__line">{'\u00A0'}</div>;
  }
  return (
    <div className="cz-term__line">
      {line.map((span, i) => {
        const css = spanStyle(span.style);
        if (span.href) {
          return (
            <a
              key={i}
              className="cz-term__link"
              href={span.href}
              target="_blank"
              rel="noopener noreferrer"
              style={css}
              onClick={(e) => openInBrowserPanel(e, span.href)}
            >
              {span.text}
            </a>
          );
        }
        return css ? (
          <span key={i} style={css}>{span.text}</span>
        ) : (
          <span key={i}>{span.text}</span>
        );
      })}
    </div>
  );
});

export const TerminalAnsiView = memo(function TerminalAnsiView({ output }: TerminalAnsiViewProps) {
  const parserRef = useRef<AnsiParser | null>(null);
  const prevOutRef = useRef<string>('');

  const lines = useMemo(() => {
    if (!parserRef.current) parserRef.current = createAnsiParser();
    const parser = parserRef.current;
    const prev = prevOutRef.current;
    if (output === prev) {
      return parser.getLines();
    }
    if (prev && output.startsWith(prev)) {
      parser.append(output.slice(prev.length));
    } else {
      parser.reset();
      parser.append(output);
    }
    prevOutRef.current = output;
    return parser.getLines();
  }, [output]);

  if (lines.length === 0) return null;

  return (
    <div className="cz-term__out">
      {lines.map((line, idx) => (
        <AnsiLineRow key={idx} line={line} />
      ))}
    </div>
  );
});
