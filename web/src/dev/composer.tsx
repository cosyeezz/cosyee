// 输入框调试页：http://127.0.0.1:5173/?dev=composer
import { useRef, useState } from 'react';
import type { Attachment, SessionConfig } from '@cosyee/shared';
import '../styles/tokens.css';
import { parseUserText } from '../core/composer';
import { Composer, type ComposerHandle } from '../ui/composer/Composer';
import {
  MOCK_SKILLS, MOCK_SLASH_COMMANDS, mockPick, mockPreviewInfo, mockPreviewRawUrl,
} from '../mock/composer';

interface Sent { text: string; attachments: Attachment[] }

export default function ComposerDev() {
  const [running, setRunning] = useState(false);
  const [mixed, setMixed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [config, setConfig] = useState<SessionConfig>({ model: 'sonnet', effort: 'medium' });
  const [sent, setSent] = useState<Sent | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [quote, setQuote] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const parsed = sent ? parseUserText(sent.text) : null;
  const pre: React.CSSProperties = {
    margin: 0, padding: 12, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10,
    fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 820, margin: '0 auto', padding: 16, gap: 12 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13 }}>
        <button onClick={() => setRunning((v) => !v)}>running：{String(running)}</button>
        <label><input type="checkbox" checked={mixed} onChange={(e) => setMixed(e.target.checked)} /> supportsMixed</label>
        <label><input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /> disabled</label>
        <button onClick={() => { setQuote('这是一段被选中的答复文字，\n可以有多行'); composerRef.current?.appendText('我的回复'); }}>模拟选中回复</button>
        <span style={{ color: 'var(--text-3)' }}>config：{JSON.stringify(config)}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>最近一次 onSend 的原始 text</div>
        <pre style={pre}>{sent ? sent.text : '（还没发送）'}</pre>
        <div>attachments</div>
        <pre style={pre}>{sent ? JSON.stringify(sent.attachments, null, 2) : ''}</pre>
        <div>parseUserText 解析回来</div>
        <pre style={pre}>{parsed ? JSON.stringify(parsed, null, 2) : ''}</pre>
        <div>事件日志</div>
        <pre style={pre}>{log.join('\n')}</pre>
      </div>
      <Composer
        ref={composerRef}
        quote={quote}
        onClearQuote={() => setQuote(null)}
        onSend={(text, attachments) => setSent({ text, attachments })}
        onInterrupt={() => { setLog((l) => [...l.slice(-9), 'onInterrupt']); setRunning(false); }}
        running={running}
        pick={mockPick}
        supportsMixed={mixed}
        previewInfo={mockPreviewInfo}
        previewRawUrl={mockPreviewRawUrl}
        slashCommands={MOCK_SLASH_COMMANDS}
        skills={MOCK_SKILLS}
        config={config}
        onConfigChange={setConfig}
        disabled={disabled}
      />
    </div>
  );
}
