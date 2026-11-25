// 把面板上的鼠标 / 键盘事件换成 agent-browser 推流的输入消息（字段同 CDP Input.dispatchMouseEvent / dispatchKeyEvent）。
// 实测：退格、方向键等非文字键必须带 windowsVirtualKeyCode，否则页面收不到编辑动作；输入法上屏的文字用 char 发。

export interface PageSize {
  width: number;
  height: number;
}

interface Mods {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** 修饰键位：Alt=1 Ctrl=2 Meta=4 Shift=8 */
export function modifiers(e: Mods): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export type MouseButton = 'left' | 'middle' | 'right' | 'none';

export function buttonName(button: number): MouseButton {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none';
}

/** 移动时按住的键（buttons 位：1 左 2 右 4 中） */
export function heldButton(buttons: number): MouseButton {
  return buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
}

/** 画面上的客户端坐标 → 页面视口坐标（CSS 像素），夹在页面范围内 */
export function toPage(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, page: PageSize): { x: number; y: number } {
  const sx = rect.width > 0 ? page.width / rect.width : 1;
  const sy = rect.height > 0 ? page.height / rect.height : 1;
  const x = Math.min(page.width - 1, Math.max(0, (clientX - rect.left) * sx));
  const y = Math.min(page.height - 1, Math.max(0, (clientY - rect.top) * sy));
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

export function mouseMsg(
  eventType: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  p: { x: number; y: number },
  button: MouseButton,
  clickCount: number,
  mods: Mods,
): object {
  return { type: 'input_mouse', eventType, x: p.x, y: p.y, button, clickCount, modifiers: modifiers(mods) };
}

/** 滚轮：按行 / 按页的增量换成像素 */
export function wheelMsg(p: { x: number; y: number }, e: { deltaX: number; deltaY: number; deltaMode: number } & Mods): object {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
  return {
    type: 'input_mouse',
    eventType: 'mouseWheel',
    x: p.x,
    y: p.y,
    button: 'none',
    deltaX: Math.round(e.deltaX * k),
    deltaY: Math.round(e.deltaY * k),
    modifiers: modifiers(e),
  };
}

interface KeyLike extends Mods {
  key: string;
  code: string;
  keyCode: number;
}

/** keyDown 带上会输入的文字（单个可见字符、回车）；Ctrl / Meta 组合键不带文字 */
export function keyMsg(eventType: 'keyDown' | 'keyUp', e: KeyLike): object {
  const m: Record<string, unknown> = {
    type: 'input_keyboard',
    eventType,
    key: e.key,
    code: e.code,
    modifiers: modifiers(e),
  };
  if (e.keyCode) m.windowsVirtualKeyCode = e.keyCode;
  if (eventType === 'keyDown' && !e.ctrlKey && !e.metaKey) {
    if ([...e.key].length === 1) m.text = e.key;
    else if (e.key === 'Enter') m.text = '\r';
  }
  return m;
}

/** 直接上屏的文字（输入法结果、粘贴）：逐个字符发 char，字数有上限 */
export function charMsgs(text: string, max = 2000): object[] {
  return [...text.replace(/\r\n?/g, '\n')].slice(0, max).map((ch) => ({ type: 'input_keyboard', eventType: 'char', text: ch === '\n' ? '\r' : ch }));
}

/** 留给 cosyee 自己处理、不转发的按键：粘贴（转成 paste 事件再发文字）和内置浏览器开关快捷键 */
export function isLocalKey(e: KeyLike, mac: boolean): boolean {
  const cmd = mac ? e.metaKey : e.ctrlKey;
  if (cmd && !e.altKey && e.key.toLowerCase() === 'v') return true;
  return isBrowserToggle(e, mac);
}

/** 开关内置浏览器：⇧⌘P（mac）/ Ctrl+Shift+P */
export function isBrowserToggle(e: KeyLike, mac: boolean): boolean {
  const cmd = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return cmd && e.shiftKey && !e.altKey && e.code === 'KeyP';
}
