// 输入框草稿的本地存储：全局只有一份（不跟会话绑定）。localStorage 不可用 / 写满时静默降级。

export const DRAFT_KEY = 'cosyee.draft';
/** 内容变化后多久写入一次 */
export const DRAFT_DELAY_MS = 300;

export function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 写入草稿；空串表示清除 */
export function writeDraft(text: string): void {
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY, text);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 隐私模式 / 配额：忽略 */
  }
}
