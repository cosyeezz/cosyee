// 等用户回应的请求（AskUserQuestion 提问 / ExitPlanMode 计划审批）：显示在输入框上方。
// 只显示队首一项；换项时用 key 重置内部状态。
// 动效：整块从输入框上沿浮起；换到下一项时卡片交叉淡入；全部回应完先下沉淡出再卸载。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AskQuestion, PendingPrompt, PromptReply, SessionConfig } from '@cosyee/shared';
import { Composer, type ComposerHandle, type ComposerProps } from '../composer/Composer';
import { Markdown } from '../flow/Markdown';
import { leavingProps, usePresence } from '../motion/usePresence';
import './PromptPanel.css';

export interface PromptPanelProps {
  /** 待回应的请求（按到达顺序） */
  items: PendingPrompt[];
  /** 回应其中一个（id = PendingPrompt.id） */
  onReply: (id: string, reply: PromptReply) => void;
  /** 修改意见框（与主输入框同一个组件）选文件 / 粘贴图片 / 预览标签用；不传则「+」选不到文件、不接受粘贴图片 */
  editor?: PromptEditorDeps;
}

/** 意见框需要的输入框能力 */
export type PromptEditorDeps = Pick<ComposerProps, 'pick' | 'paste' | 'supportsMixed' | 'previewInfo' | 'previewRawUrl'>;

const noop = () => {};
const NO_EDITOR: PromptEditorDeps = {
  pick: async () => ({ items: [], supportsMixed: false }),
  supportsMixed: false,
  previewInfo: async () => { throw new Error('预览不可用'); },
  previewRawUrl: () => '',
};
// 意见框不显示底栏，模型配置用不到
const NO_CONFIG: SessionConfig = { model: '', effort: 'medium' };
const NONE: string[] = [];

export function PromptPanel({ items, onReply, editor = NO_EDITOR }: PromptPanelProps) {
  const ref = useRef<HTMLElement>(null);
  // 退场期间 items 已经空了：继续显示最后一份
  const last = useRef(items);
  if (items.length) last.current = items;
  const { mounted, leaving } = usePresence(items.length > 0, ref, 140);
  // 这次出现时的第一项：之后换成别的项才播「换项」动画，刚出现时只播整块的入场
  const enterId = useRef<string | null>(null);
  const shown = items.length ? items : last.current;
  const cur = mounted ? shown[0] : undefined;
  if (!cur) {
    enterId.current = null;
    return null;
  }
  if (enterId.current === null) enterId.current = cur.id;
  const swap = cur.id !== enterId.current;
  const more = shown.length - 1;
  // 退场中不再接受回应（数字键快捷键是全局监听的）
  const reply = leaving ? noop : onReply;
  const cardCls = swap ? ' is-swap' : '';
  return (
    <section
      ref={ref}
      className={`cz-prompt${leaving ? ' is-leaving' : ''}`}
      role="dialog"
      aria-label={cur.kind === 'question' ? 'Claude 的提问' : '计划审批'}
      {...leavingProps(leaving)}
    >
      {cur.kind === 'question' ? (
        <QuestionCard key={cur.id} id={cur.id} questions={cur.questions} onReply={reply} cls={cardCls} />
      ) : (
        <PlanCard key={cur.id} id={cur.id} plan={cur.plan} planFilePath={cur.planFilePath} onReply={reply} cls={cardCls} editor={editor} />
      )}
      {more > 0 && <div className="cz-prompt__more">还有 {more} 个待处理</div>}
    </section>
  );
}

// ───────────── 提问 ─────────────

interface QState {
  picks: string[];
  custom: string;
  customOn: boolean;
}
const EMPTY_Q: QState = { picks: [], custom: '', customOn: false };

/** 一个问题当前的答案；没有答案返回空串 */
function answerOf(q: AskQuestion, s: QState): string {
  const custom = s.customOn ? s.custom.trim() : '';
  if (q.multiSelect) return [...s.picks, ...(custom ? [custom] : [])].join(', ');
  return custom || s.picks[0] || '';
}

const isTextTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

function QuestionCard({ id, questions, onReply, cls }: { id: string; questions: AskQuestion[]; onReply: PromptPanelProps['onReply']; cls: string }) {
  const [state, setState] = useState<QState[]>(() => questions.map(() => EMPTY_Q));
  const quick = questions.length === 1 && !questions[0]!.multiSelect;
  const answers = questions.map((q, i) => answerOf(q, state[i] ?? EMPTY_Q));
  const valid = answers.every(Boolean);

  const submit = (finalAnswers = answers) => {
    if (!finalAnswers.every(Boolean)) return;
    onReply(id, { kind: 'answer', answers: Object.fromEntries(questions.map((q, i) => [q.question, finalAnswers[i]!])) });
  };
  const patch = (i: number, fn: (s: QState) => QState) => setState((all) => all.map((s, j) => (j === i ? fn(s) : s)));

  const pick = (i: number, label: string) => {
    const q = questions[i]!;
    if (q.multiSelect) {
      patch(i, (s) => ({ ...s, picks: s.picks.includes(label) ? s.picks.filter((x) => x !== label) : [...s.picks, label] }));
    } else if (quick) {
      submit([label]);
    } else {
      patch(i, (s) => ({ ...s, picks: [label], customOn: false }));
    }
  };
  const toggleCustom = (i: number) =>
    patch(i, (s) => ({ ...s, customOn: !s.customOn, picks: !s.customOn && !questions[i]!.multiSelect ? [] : s.picks }));
  const typeCustom = (i: number, v: string) =>
    patch(i, (s) => ({ ...s, custom: v, customOn: true, picks: questions[i]!.multiSelect ? s.picks : [] }));

  // 全局按键：数字键选（第一个）问题的选项，Enter 提交；焦点在输入框 / 按钮上时不抢
  const latest = useRef({ pick, submit, valid });
  latest.current = { pick, submit, valid };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target)) return;
      if (/^[1-9]$/.test(e.key)) {
        const opt = questions[0]!.options[Number(e.key) - 1];
        if (opt) {
          e.preventDefault();
          latest.current.pick(0, opt.label);
        }
      } else if (e.key === 'Enter' && !quick && latest.current.valid && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
        e.preventDefault();
        latest.current.submit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [questions, quick]);

  // 选项依次浮现：跨问题连续编号，CSS 里封顶
  let seq = 0;
  const stagger = () => ({ '--i': seq++ }) as CSSProperties;
  return (
    <div className={`cz-prompt__card${cls}`}>
      <div className="cz-prompt__title">Claude 想问你</div>
      <div className="cz-prompt__body">
        {questions.map((q, i) => {
          const s = state[i] ?? EMPTY_Q;
          const role = q.multiSelect ? 'checkbox' : 'radio';
          return (
            <div key={i} className="cz-prompt__q" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
              <div className="cz-prompt__qtext">
                {q.header && <span className="cz-prompt__chip">{q.header}</span>}
                {q.question}
                {q.multiSelect && <span className="cz-prompt__hint">可多选</span>}
              </div>
              {q.options.map((o, j) => {
                const on = s.picks.includes(o.label);
                return (
                  <button
                    key={j}
                    type="button"
                    role={role}
                    aria-checked={on}
                    className={`cz-prompt__opt${on ? ' is-on' : ''}`}
                    style={stagger()}
                    onClick={() => pick(i, o.label)}
                  >
                    <span className={`cz-prompt__mark cz-prompt__mark--${role}`} aria-hidden="true" />
                    <span className="cz-prompt__optmain">
                      <span className="cz-prompt__label">{o.label}</span>
                      {o.description && <span className="cz-prompt__desc">{o.description}</span>}
                    </span>
                    {i === 0 && j < 9 && <kbd className="cz-prompt__key">{j + 1}</kbd>}
                  </button>
                );
              })}
              <div className={`cz-prompt__opt cz-prompt__opt--custom${s.customOn ? ' is-on' : ''}`} style={stagger()}>
                <button
                  type="button"
                  role={role}
                  aria-checked={s.customOn}
                  aria-label="其他"
                  className="cz-prompt__markbtn"
                  onClick={() => toggleCustom(i)}
                >
                  <span className={`cz-prompt__mark cz-prompt__mark--${role}`} aria-hidden="true" />
                </button>
                <input
                  type="text"
                  className="cz-prompt__input"
                  placeholder="其他：输入自己的回答"
                  aria-label="其他回答"
                  value={s.custom}
                  onChange={(e) => typeCustom(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
                    e.preventDefault();
                    if (valid) submit();
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="cz-prompt__actions">
        <button type="button" className="cz-prompt__btn" onClick={() => onReply(id, { kind: 'skip' })}>跳过</button>
        {!quick && (
          <button type="button" className="cz-prompt__btn cz-prompt__btn--primary" disabled={!valid} onClick={() => submit()}>提交</button>
        )}
      </div>
    </div>
  );
}

// ───────────── 计划 ─────────────

function PlanCard({ id, plan, planFilePath, onReply, cls, editor }: { id: string; plan: string; planFilePath?: string; onReply: PromptPanelProps['onReply']; cls: string; editor: PromptEditorDeps }) {
  const [revising, setRevising] = useState(false);
  const [empty, setEmpty] = useState(true);
  const ref = useRef<ComposerHandle>(null);
  // 意见里的 `@"路径"`（文件 / 粘贴的图片）原样发出，模型自己去读
  const send = (text: string) => {
    const f = text.trim();
    if (f) onReply(id, { kind: 'revise', feedback: f });
  };
  const cancel = () => {
    setRevising(false);
    setEmpty(true);
  };
  return (
    <div className={`cz-prompt__card${cls}`}>
      <div className="cz-prompt__title">计划已就绪，等你批准</div>
      <div className="cz-prompt__plan">
        <Markdown text={plan} className="cz-flow__md--small" />
      </div>
      {planFilePath && <div className="cz-prompt__path" title={planFilePath}>{planFilePath}</div>}
      {revising && (
        <div className="cz-prompt__feedback">
          <Composer
            ref={ref}
            inline
            autoFocus
            placeholder="说说想怎么改（Enter 发送，Shift+Enter 换行）"
            onSend={send}
            onEmptyChange={setEmpty}
            onEscape={cancel}
            onInterrupt={noop}
            running={false}
            {...editor}
            slashCommands={NONE}
            skills={NONE}
            config={NO_CONFIG}
            onConfigChange={noop}
          />
        </div>
      )}
      <div className="cz-prompt__actions">
        {revising ? (
          <>
            <button type="button" className="cz-prompt__btn" onClick={cancel}>取消</button>
            <button type="button" className="cz-prompt__btn cz-prompt__btn--primary" disabled={empty} onClick={() => ref.current?.submit()}>发送意见</button>
          </>
        ) : (
          <>
            <button type="button" className="cz-prompt__btn" onClick={() => setRevising(true)}>继续完善</button>
            <button type="button" className="cz-prompt__btn cz-prompt__btn--primary" title="批准后切换到自动模式执行" onClick={() => onReply(id, { kind: 'approve' })}>
              批准并执行
            </button>
          </>
        )}
      </div>
    </div>
  );
}
