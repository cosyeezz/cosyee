// 展开区的三种步骤：思考 / 中间说明文字 / 工具调用。
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Step, TextStep, ThinkingStep, ToolStep } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { Markdown } from './Markdown';
import { CodeBlock } from './Markdown';
import { toolIconName } from './toolIcon';
import { describeToolInput, toolContentToText, truncateText } from './format';
import { hasThinkingText, thinkingFirstLine, thinkingLabel } from './thinking';
import './flow.css';

const OUTPUT_LIMIT = 2000;

/** 内容区离底部多近算「贴底」（px）：贴底时流式追加会自动滚到底，用户往上翻了就不打扰 */
const STICK_SLACK = 8;

/**
 * 思考行。
 * - 进行中（streaming）默认展开，内容实时追加，内容区限高并自动滚到底；
 * - 完成后自动折叠，折叠态显示第一行；点击展开 / 收起；
 * - 进行中用户手动收起后不再强制展开（userOpen 记住用户的选择；思考结束时清掉，回到默认折叠）；
 * - 历史记录里的思考块（非流式）默认折叠；
 * - 没有文本（模型只给 token 计数）时只显示「已思考（N tokens）」，不可展开。
 */
export const ThinkingRow = memo(function ThinkingRow({ step }: { step: ThinkingStep }) {
  const streaming = !!step.streaming;
  const hasText = hasThinkingText(step.text);
  // null：用户没点过，跟随默认（进行中展开、完成后折叠）
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 思考结束（streaming true → false）时清掉用户选择，回到默认折叠（渲染期调整，避免多一帧展开态）
  const [prevStreaming, setPrevStreaming] = useState(streaming);
  if (prevStreaming !== streaming) {
    setPrevStreaming(streaming);
    if (!streaming) setUserOpen(null);
  }
  const open = hasText && (userOpen ?? streaming);

  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 每次展开都从「贴底」开始（必须在下面的滚动 effect 之前声明，effect 按声明顺序执行）
  useLayoutEffect(() => {
    if (open) stick.current = true;
  }, [open]);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && open && streaming && stick.current) el.scrollTop = el.scrollHeight;
  }, [open, streaming, step.text]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK;
  };

  const preview = useMemo(() => (hasText && !open ? thinkingFirstLine(step.text) : ''), [hasText, open, step.text]);
  const cls = `cz-flow__thinking${open ? ' is-open' : ''}${streaming ? ' is-streaming' : ''}`;
  const icon = <Icon name="thinking" size={16} className="cz-flow__step-icon cz-flow__thinking-icon" />;
  const label = <span className="cz-flow__thinking-label">{thinkingLabel(step)}</span>;

  if (!hasText) {
    return (
      <div className={cls}>
        <div className="cz-flow__row-btn cz-flow__thinking-static">
          {icon}
          {label}
        </div>
      </div>
    );
  }
  return (
    <div className={cls}>
      <button type="button" className="cz-flow__row-btn" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        {icon}
        {label}
        {preview && (
          <span className="cz-flow__thinking-preview" title={preview}>
            {preview}
          </span>
        )}
        <Icon name="chevron" size={16} open={open} className="cz-flow__chev" />
      </button>
      {open && (
        <div ref={bodyRef} className="cz-flow__thinking-body" onScroll={onScroll}>
          {step.text}
        </div>
      )}
    </div>
  );
});

const TextRow = memo(function TextRow({ step }: { step: TextStep }) {
  return (
    <div className="cz-flow__note">
      <Icon name="note" size={16} className="cz-flow__step-icon" />
      <Markdown text={step.text} className="cz-flow__md--small" />
    </div>
  );
});

/** 一段可截断的代码输出 */
function OutputBlock({ text, lang }: { text: string; lang: string }) {
  const [all, setAll] = useState(false);
  const cut = useMemo(() => truncateText(text, OUTPUT_LIMIT), [text]);
  const shown = all ? text : cut.text;
  return (
    <>
      <CodeBlock lang={lang} text={text}>
        <code>{shown}</code>
      </CodeBlock>
      {cut.truncated && !all && (
        <button type="button" className="cz-flow__more" onClick={() => setAll(true)}>
          已截断，共 {cut.total} 字符，显示全部
        </button>
      )}
    </>
  );
}

const ToolRow = memo(function ToolRow({ step, turnActive }: { step: ToolStep; turnActive: boolean }) {
  const [open, setOpen] = useState(false);
  const isError = !!step.result?.isError;
  const running = !!step.streaming || (!step.result && turnActive);
  const input = useMemo(() => (open ? describeToolInput(step) : null), [open, step]);
  const output = useMemo(() => (open && step.result ? toolContentToText(step.result.content) : ''), [open, step.result]);
  return (
    <div className={`cz-flow__tool${open ? ' is-open' : ''}${isError ? ' is-error' : ''}`}>
      <button type="button" className="cz-flow__row-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon
          name={toolIconName(step.name, isError)}
          size={16}
          running={running}
          className="cz-flow__tool-icon"
        />
        <span className="cz-flow__tool-summary" title={step.summary}>
          {step.summary || step.name}
        </span>
        {isError && <span className="cz-flow__badge">失败</span>}
        <Icon name="chevron" size={16} open={open} className="cz-flow__chev" />
      </button>
      {open && input && (
        <div className="cz-flow__tool-body">
          <div className="cz-flow__io-label">输入</div>
          {input.text ? <OutputBlock text={input.text} lang={input.lang} /> : <div className="cz-flow__io-empty">（空）</div>}
          <div className="cz-flow__io-label">输出</div>
          {step.result ? (
            output ? (
              <OutputBlock text={output} lang="text" />
            ) : (
              <div className="cz-flow__io-empty">（无输出）</div>
            )
          ) : (
            <div className="cz-flow__io-empty">{turnActive ? '执行中…' : '（无结果）'}</div>
          )}
        </div>
      )}
    </div>
  );
});

export const StepView = memo(function StepView({ step, turnActive }: { step: Step; turnActive: boolean }) {
  switch (step.kind) {
    case 'thinking':
      return <ThinkingRow step={step} />;
    case 'text':
      return <TextRow step={step} />;
    case 'tool':
      return <ToolRow step={step} turnActive={turnActive} />;
  }
});
