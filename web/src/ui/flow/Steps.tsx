// 展开区的三种步骤：思考 / 中间说明文字 / 工具调用。
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Step, TextStep, ThinkingStep, ToolStep } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { Markdown } from './Markdown';
import { CodeBlock } from './Markdown';
import { toolIconName } from './toolIcon';
import { useFiles } from '../files/FileContext';
import { describeToolInput, parseAskAnswers, parseAskQuestions, planOf, planVerdict, toolContentToText, toolFilePath, toolLine, truncateText } from './format';
import { hasThinkingText, thinkingFirstLine, thinkingTokensLabel } from './thinking';
import './flow.css';

const OUTPUT_LIMIT = 2000;

/** 内容区离底部多近算「贴底」（px）：贴底时流式追加会自动滚到底，用户往上翻了就不打扰 */
const STICK_SLACK = 8;

/**
 * 思考行（不带「思考中 / 已思考」之类的措辞）。
 * - 进行中（streaming）默认展开，直接显示思考内容，实时追加，内容区限高并自动滚到底；
 * - 完成后自动折叠，折叠态只显示第一行，点击展开看全文 / 再点收起；
 * - 进行中用户手动收起后不再强制展开（userOpen 记住用户的选择；思考结束时清掉，回到默认折叠）；
 * - 历史记录里的思考块（非流式）默认折叠；
 * - 没有文本（模型只给 token 计数）时只显示图标和「N tokens」，不可展开。
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

  if (!hasText) {
    const tokens = thinkingTokensLabel(step);
    return (
      <div className={cls}>
        <div className="cz-flow__row-btn cz-flow__thinking-static">
          {icon}
          {tokens && <span className="cz-flow__thinking-label">{tokens}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className={cls}>
      <button
        type="button"
        className="cz-flow__row-btn"
        aria-expanded={open}
        aria-label={preview ? undefined : open ? '收起思考内容' : '展开思考内容'}
        onClick={() => setUserOpen(!open)}
      >
        {icon}
        {preview && (
          <span className="cz-flow__thinking-preview" title={preview}>
            {preview}
          </span>
        )}
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

/** AskUserQuestion 展开区：每个问题 + 选项，答案从结果文本里解析（解析不出显示原文） */
function AskBody({ step, output, turnActive }: { step: ToolStep; output: string; turnActive: boolean }) {
  const qs = useMemo(() => parseAskQuestions(step.input), [step.input]);
  const answers = useMemo(() => (output ? parseAskAnswers(output) : null), [output]);
  return (
    <div className="cz-flow__tool-body cz-flow__ask">
      {qs.map((q, i) => {
        const ans = answers?.[q.question];
        const picked = ans ? ans.split(', ') : [];
        return (
          <div key={i} className="cz-flow__ask-q">
            <div className="cz-flow__ask-title">
              {q.header && <span className="cz-flow__ask-chip">{q.header}</span>}
              {q.question}
            </div>
            <ul className="cz-flow__ask-opts">
              {q.options.map((o, j) => (
                <li key={j} className={picked.includes(o.label) ? 'is-picked' : undefined}>
                  <b>{o.label}</b>
                  {o.description && <span className="cz-flow__ask-desc"> — {o.description}</span>}
                </li>
              ))}
            </ul>
            {ans && <div className="cz-flow__ask-ans">回答：{ans}</div>}
          </div>
        );
      })}
      {!answers && (step.result ? (output ? <OutputBlock text={output} lang="text" /> : <div className="cz-flow__io-empty">（无输出）</div>) : <div className="cz-flow__io-empty">{turnActive ? '等待回答…' : '（无结果）'}</div>)}
    </div>
  );
}

/** ExitPlanMode 展开区：计划用 Markdown 渲染，结果压成一行状态 */
function PlanBody({ step, output, turnActive }: { step: ToolStep; output: string; turnActive: boolean }) {
  const plan = planOf(step.input);
  const verdict = step.result ? planVerdict(output, !!step.result.isError) : null;
  return (
    <div className="cz-flow__tool-body cz-flow__plan">
      {plan ? <Markdown text={plan} className="cz-flow__md--small" /> : <div className="cz-flow__io-empty">（空）</div>}
      <div className={`cz-flow__plan-status${verdict && !verdict.approved ? ' is-no' : ''}`}>
        {verdict ? (verdict.approved ? '已批准' : `未批准${verdict.feedback ? `：${verdict.feedback}` : ''}`) : step.result ? '（无结果）' : turnActive ? '等待批准…' : '（无结果）'}
      </div>
    </div>
  );
}

const ToolRow = memo(function ToolRow({ step, turnActive }: { step: ToolStep; turnActive: boolean }) {
  const [open, setOpen] = useState(false);
  const isError = !!step.result?.isError;
  const running = !!step.streaming || (!step.result && turnActive);
  const input = useMemo(() => (open ? describeToolInput(step) : null), [open, step]);
  const output = useMemo(() => (open && step.result ? toolContentToText(step.result.content) : ''), [open, step.result]);
  const files = useFiles();
  const filePath = toolFilePath(step);
  // 显示摘要里「工具名: 」后面的部分（通常是相对路径，更短）；没有就显示完整路径
  const prefix = `${step.name}: `;
  const pathLabel = step.summary?.startsWith(prefix) && step.summary.length > prefix.length ? step.summary.slice(prefix.length) : filePath;
  const line = toolLine(step);
  const interactive = step.name === 'AskUserQuestion' || step.name === 'ExitPlanMode';
  const toggle = () => setOpen((v) => !v);
  const icon = <Icon name={toolIconName(step.name, isError)} size={16} running={running} className="cz-flow__tool-icon" />;
  return (
    <div className={`cz-flow__tool${open ? ' is-open' : ''}${isError ? ' is-error' : ''}`}>
      {filePath && files ? (
        // 摘要里的文件路径单独是一个按钮（点击打开预览），行的其余部分仍是展开 / 收起按钮；两者是兄弟节点，不嵌套
        <div className="cz-flow__row-split">
          <button type="button" className="cz-flow__row-btn cz-flow__row-btn--lead" aria-expanded={open} onClick={toggle}>
            {icon}
            <span className="cz-flow__tool-name">{step.name}:</span>
          </button>
          <button
            type="button"
            className="cz-flow__tool-path"
            title={filePath}
            data-file-path={filePath}
            onClick={(e) => files.open({ path: filePath }, e.currentTarget)}
          >
            {pathLabel}
          </button>
          <button type="button" className="cz-flow__row-btn cz-flow__row-btn--tail" aria-expanded={open} aria-label={open ? '收起工具详情' : '展开工具详情'} onClick={toggle}>
            {isError && <span className="cz-flow__badge">失败</span>}
          </button>
        </div>
      ) : (
        <button type="button" className="cz-flow__row-btn" aria-expanded={open} onClick={toggle}>
          {icon}
          <span className="cz-flow__tool-summary" title={line}>
            {line}
          </span>
          {isError && <span className="cz-flow__badge">失败</span>}
        </button>
      )}
      {open && interactive && (step.name === 'AskUserQuestion' ? <AskBody step={step} output={output} turnActive={turnActive} /> : <PlanBody step={step} output={output} turnActive={turnActive} />)}
      {open && !interactive && input && (
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
