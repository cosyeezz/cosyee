// 2FA「添加 / 导入」流程视图：扫描屏幕 / 二维码图片 / OTP 链接 / 备份文件 → 预览确认 → 导入。
// 由 2FA 面板挂在列表的位置（与添加表单同槽同尺寸）：头部返回箭头 + 标题、可滚动正文、底部操作栏。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blobToRgbaImage, findAllQrInImageData } from '../../core/twofa/qr';
import {
  getScanAvailability,
  grabBrowserFrame,
  grabDisplayFrame,
  scanNative,
  ScreenCaptureError,
  type ScreenFrame,
} from '../../core/twofa/screenScan';
import { issuerColorKey, issuerInitial } from '../../core/twofa/tree';
import type {
  TwoFaGroup,
  TwoFaImportInput,
  TwoFaImportPreviewInput,
  TwoFaImportPreviewItem,
  TwoFaImportPreviewResult,
  TwoFaImportResult,
} from '../../core/twofa/types';
import { Icon } from '../icons/Icon';
import { GroupPicker } from './GroupPicker';
import { ScreenRegionPicker } from './ScreenRegionPicker';
import './TwoFactorImport.css';

export type TwoFaImportMethod = 'scan' | 'image' | 'link' | 'backup';

export interface TwoFactorImportViewProps {
  method: TwoFaImportMethod;
  groups: TwoFaGroup[];
  /** 用户当前正在浏览的分组，作为导入目标的默认值 */
  defaultGroupId: string | null;
  previewImport: (input: TwoFaImportPreviewInput) => Promise<TwoFaImportPreviewResult>;
  importText: (input: TwoFaImportInput) => Promise<TwoFaImportResult>;
  /** 返回列表（不导入） */
  onBack: () => void;
  /** 导入完成：面板弹提示并回到列表 */
  onDone: (result: TwoFaImportResult) => void;
  onSwitchMethod?: (m: TwoFaImportMethod) => void;
}

const TITLES: Record<TwoFaImportMethod, string> = {
  scan: '扫描二维码',
  image: '导入二维码图片',
  link: '导入 OTP 链接',
  backup: '导入备份文件',
};

const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

// ───────────────────────── 小图形 ─────────────────────────

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function QrGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.4" />
      <path d="M14 14h2.4v2.4M20.5 14v.01M14 20.5h.01M17 18.2h3.5M17.2 20.5h3.3" />
    </svg>
  );
}

function ScreenGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <rect x="2.8" y="4.5" width="18.4" height="12.2" rx="2" />
      <path d="M8.5 20h7M12 16.7V20" />
      <path d="M9 8.8h2M9 8.8v2M15 8.8h-2M15 8.8v2M9 12.4h2M15 12.4h-2" strokeWidth="1.3" />
    </svg>
  );
}

function BrowserGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <path d="M3 9.2h18" />
      <path d="M6.2 6.9h.01M8.6 6.9h.01" strokeWidth="1.8" />
      <path d="M9.2 13.2h2v2h-2zM13 13.2h2v2h-2z" strokeWidth="1.3" />
    </svg>
  );
}

function ImageGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m4.5 17.5 4.6-4.4a1.5 1.5 0 0 1 2.1 0l2.2 2.1 2-1.9a1.5 1.5 0 0 1 2.1 0l2 1.9" />
    </svg>
  );
}

function FileGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M14 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8z" />
      <path d="M14 3.5V8h4.5M9 13h6M9 16.2h4" />
    </svg>
  );
}

function Spinner() {
  return <span className="cz-2fa-imp__spin" aria-hidden="true" />;
}

// ───────────────────────── 主视图 ─────────────────────────

interface PreviewState {
  text: string;
  result: TwoFaImportPreviewResult;
}

export function TwoFactorImportView(props: TwoFactorImportViewProps) {
  const { method, groups, defaultGroupId, previewImport, importText, onBack, onDone, onSwitchMethod } = props;
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 来源 → 文本 → 预览
  const submitText = useCallback(
    async (text: string): Promise<boolean> => {
      const t = text.trim();
      if (!t) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await previewImport({ text: t });
        if (!alive.current) return false;
        if (res.items.length === 0) {
          const why = res.errors[0] ?? (res.unsupported > 0 ? `发现 ${res.unsupported} 条暂不支持的验证码（如 HOTP）` : '没有找到可导入的验证码');
          setError(why);
          return false;
        }
        setPreview({ text: t, result: res });
        return true;
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : '解析失败');
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [previewImport],
  );

  const back = () => {
    if (preview) {
      setPreview(null);
      setError(null);
    } else onBack();
  };

  return (
    <div className="cz-2fa-imp">
      <div className="cz-2fa-imp__head">
        <button type="button" className="cz-2fa-ib" onClick={back} aria-label="返回">
          <Icon name="arrow-left" size={15} />
        </button>
        <span className="cz-2fa-imp__title">{preview ? '确认导入' : TITLES[method]}</span>
      </div>

      {preview ? (
        <PreviewStep
          key="preview"
          preview={preview}
          groups={groups}
          defaultGroupId={defaultGroupId}
          importText={importText}
          onEdit={() => {
            setPreview(null);
            setError(null);
          }}
          onDone={onDone}
        />
      ) : (
        <div className="cz-2fa-imp__step" key={`src-${method}`}>
          {method === 'scan' && (
            <ScanSource busy={busy} error={error} setError={setError} submitText={submitText} onBack={onBack} onSwitchMethod={onSwitchMethod} />
          )}
          {method === 'image' && <ImageSource busy={busy} error={error} setError={setError} submitText={submitText} />}
          {method === 'link' && <LinkSource busy={busy} error={error} setError={setError} submitText={submitText} onBack={onBack} />}
          {method === 'backup' && <BackupSource busy={busy} error={error} setError={setError} submitText={submitText} onBack={onBack} />}
        </div>
      )}
    </div>
  );
}

export default TwoFactorImportView;

// ───────────────────────── 来源：公共 ─────────────────────────

interface SourceProps {
  busy: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  submitText: (text: string) => Promise<boolean>;
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="cz-2fa-imp__err" role="alert" key={error}>
      <Icon name="info" size={13} />
      <span>{error}</span>
    </div>
  );
}

/** 从剪贴板事件里取图片文件 */
function imagesFromClipboard(e: ClipboardEvent): File[] {
  const out: File[] = [];
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** 解出若干文件里的二维码文本；onItem 逐个回报结果 */
async function decodeBlob(blob: Blob): Promise<string[]> {
  const img = await blobToRgbaImage(blob);
  if (!img) return [];
  return findAllQrInImageData(img, 6).map((h) => h.text);
}

// ───────────────────────── 来源：扫描 ─────────────────────────

function ScanSource({
  busy,
  error,
  setError,
  submitText,
  onBack,
  onSwitchMethod,
}: SourceProps & { onBack: () => void; onSwitchMethod?: (m: TwoFaImportMethod) => void }) {
  const avail = useMemo(() => getScanAvailability(), []);
  const [native, setNative] = useState<'idle' | 'waiting' | 'error'>(avail.native.available ? 'waiting' : 'idle');
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [grabbing, setGrabbing] = useState<null | 'display' | 'browserFrame'>(null);
  const [pasting, setPasting] = useState(false);
  const startedRef = useRef(false);

  const runNative = useCallback(async () => {
    setNative('waiting');
    setError(null);
    const res = await scanNative();
    if (res.status === 'ok') {
      const ok = await submitText(res.texts.join('\n'));
      if (!ok) setNative('error');
    } else if (res.status === 'cancelled') {
      onBack();
    } else {
      setError(res.message);
      setNative('error');
    }
  }, [onBack, setError, submitText]);

  useEffect(() => {
    if (!avail.native.available || startedRef.current) return;
    startedRef.current = true;
    void runNative();
  }, [avail.native.available, runNative]);

  const takeDisplay = async () => {
    setError(null);
    setGrabbing('display');
    try {
      setFrame(await grabDisplayFrame());
    } catch (e) {
      if (!(e instanceof ScreenCaptureError && e.code === 'cancelled')) setError(e instanceof Error ? e.message : '截取屏幕失败');
    } finally {
      setGrabbing(null);
    }
  };

  const takeBrowser = () => {
    setError(null);
    const f = grabBrowserFrame();
    if (f) setFrame(f);
    else setError('没有取到内置浏览器的画面，请先打开内置浏览器面板');
  };

  const decodeFiles = useCallback(
    async (files: Blob[]) => {
      setError(null);
      setPasting(true);
      try {
        const texts: string[] = [];
        for (const f of files) texts.push(...(await decodeBlob(f)));
        if (texts.length === 0) setError('图片里没有识别到二维码');
        else await submitText(Array.from(new Set(texts)).join('\n'));
      } finally {
        setPasting(false);
      }
    },
    [setError, submitText],
  );

  // Ctrl+V 粘贴截图
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesFromClipboard(e);
      if (files.length === 0) return;
      e.preventDefault();
      void decodeFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [decodeFiles]);

  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      const blobs: Blob[] = [];
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) blobs.push(await it.getType(type));
      }
      if (blobs.length === 0) setError('剪贴板里没有图片');
      else await decodeFiles(blobs);
    } catch {
      setError('无法直接读取剪贴板，请按 Ctrl+V 粘贴截图');
    }
  };

  // 桌面客户端：原生框选，页面只显示等待态
  if (avail.native.available) {
    return (
      <>
        <div className="cz-2fa-imp__body is-center">
          <div className={`cz-2fa-imp__wait${native === 'error' ? ' is-err' : ''}`}>
            <div className="cz-2fa-imp__wait-ring">
              {native === 'error' ? <QrGlyph size={26} /> : <QrGlyph size={26} />}
              {native === 'waiting' && <span className="cz-2fa-imp__wait-pulse" />}
            </div>
            <div className="cz-2fa-imp__wait-title">{native === 'error' ? '没有拿到二维码' : busy ? '正在解析…' : '正在等待框选…'}</div>
            <div className="cz-2fa-imp__wait-desc">
              {native === 'error' ? '可以重新框选，或换用其它导入方式' : '在屏幕上拖动框选二维码，按 Esc 取消'}
            </div>
          </div>
          <ErrorLine error={error} />
        </div>
        <div className="cz-2fa-imp__foot">
          <button type="button" className="cz-2fa-btn" onClick={onBack}>取消</button>
          {native === 'error' && (
            <button type="button" className="cz-2fa-btn is-primary" onClick={() => void runNative()}>
              重新框选
            </button>
          )}
        </div>
      </>
    );
  }

  const card = (
    kind: 'display' | 'browserFrame',
    icon: JSX.Element,
    title: string,
    desc: string,
    onClick: () => void,
  ) => {
    const st = avail[kind];
    const loading = grabbing === kind;
    return (
      <button
        type="button"
        className={`cz-2fa-imp__card${st.available ? '' : ' is-off'}`}
        disabled={!st.available || !!grabbing || busy}
        onClick={onClick}
      >
        <span className="cz-2fa-imp__card-ic">{loading ? <Spinner /> : icon}</span>
        <span className="cz-2fa-imp__card-tx">
          <span className="cz-2fa-imp__card-title">{title}</span>
          <span className="cz-2fa-imp__card-desc">{st.available ? desc : st.reason}</span>
        </span>
        {st.available && (
          <span className="cz-2fa-imp__card-go">
            <Icon name="chevron-right" size={14} />
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      <div className="cz-2fa-imp__body">
        <p className="cz-2fa-imp__lead">选择二维码所在的位置，框选后自动识别。</p>
        <div className="cz-2fa-imp__cards">
          {card('display', <ScreenGlyph />, '扫描屏幕', '选择一个屏幕或窗口，再框选二维码', () => void takeDisplay())}
          {card('browserFrame', <BrowserGlyph />, '扫描内置浏览器页面', '直接识别内置浏览器当前显示的画面', takeBrowser)}
        </div>

        <div className="cz-2fa-imp__or">
          <span>或者</span>
        </div>
        <div className="cz-2fa-imp__quick">
          <button type="button" className="cz-2fa-imp__qbtn" disabled={busy || pasting} onClick={() => onSwitchMethod?.('image')}>
            <ImageGlyph size={16} />
            <span>导入二维码图片</span>
          </button>
          <button
            type="button"
            className="cz-2fa-imp__qbtn"
            title="也可以直接按 Ctrl+V"
            disabled={busy || pasting}
            onClick={() => void pasteFromClipboard()}
          >
            {pasting || busy ? <Spinner /> : <Icon name="copy" size={15} />}
            <span>粘贴截图</span>
          </button>
        </div>
        <ErrorLine error={error} />
      </div>
      {frame && (
        <ScreenRegionPicker
          frame={frame.canvas}
          onCancel={() => setFrame(null)}
          onResult={(text) => {
            setFrame(null);
            void submitText(text);
          }}
        />
      )}
    </>
  );
}

// ───────────────────────── 来源：图片 ─────────────────────────

interface ImgItem {
  id: number;
  name: string;
  url: string;
  status: 'pending' | 'ok' | 'none';
  texts: string[];
}

function ImageSource({ busy, error, setError, submitText }: SourceProps) {
  const [items, setItems] = useState<ImgItem[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const urls = useRef(new Set<string>());
  const depth = useRef(0);

  useEffect(() => {
    const set = urls.current;
    return () => {
      set.forEach((u) => URL.revokeObjectURL(u));
      set.clear();
    };
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name));
      if (imgs.length === 0) {
        setError('请选择图片文件（PNG / JPG / WebP 等）');
        return;
      }
      setError(null);
      const fresh: ImgItem[] = imgs.map((f, i) => {
        const url = URL.createObjectURL(f);
        urls.current.add(url);
        return { id: ++seq.current, name: f.name || `粘贴的图片 ${seq.current}`, url, status: 'pending', texts: [] };
      });
      setItems((prev) => [...prev, ...fresh]);
      fresh.forEach((it, i) => {
        void decodeBlob(imgs[i]).then(
          (texts) => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, status: texts.length ? 'ok' : 'none', texts } : p))),
          () => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, status: 'none' } : p))),
        );
      });
    },
    [setError],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesFromClipboard(e);
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const remove = (id: number) => {
    setItems((prev) => {
      const it = prev.find((p) => p.id === id);
      if (it) {
        URL.revokeObjectURL(it.url);
        urls.current.delete(it.url);
      }
      return prev.filter((p) => p.id !== id);
    });
  };

  const allTexts = Array.from(new Set(items.flatMap((i) => i.texts)));
  const pending = items.some((i) => i.status === 'pending');
  const okCount = items.filter((i) => i.status === 'ok').length;

  return (
    <>
      <div className="cz-2fa-imp__body">
        <div
          className={`cz-2fa-imp__drop${over ? ' is-over' : ''}${items.length ? ' is-compact' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            depth.current++;
            setOver(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            depth.current = 0;
            setOver(false);
            addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <span className="cz-2fa-imp__drop-ic">
            <ImageGlyph size={items.length ? 20 : 30} />
          </span>
          <span className="cz-2fa-imp__drop-title">{over ? '松开即可识别' : items.length ? '继续添加图片' : '点击选择，或把图片拖到这里'}</span>
          {!items.length && (
            <span className="cz-2fa-imp__drop-desc">
              支持 PNG / JPG / WebP，可一次选多张
              <br />
              也可以直接按 <kbd>Ctrl+V</kbd> 粘贴截图
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="cz-2fa-hidden-file"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>

        {items.length > 0 && (
          <ul className="cz-2fa-imp__thumbs">
            {items.map((it) => (
              <li key={it.id} className={`cz-2fa-imp__thumb is-${it.status}`}>
                <span className="cz-2fa-imp__thumb-img">
                  <img src={it.url} alt="" draggable={false} />
                </span>
                <span className="cz-2fa-imp__thumb-info">
                  <span className="cz-2fa-imp__thumb-name" title={it.name}>{it.name}</span>
                  <span className="cz-2fa-imp__thumb-st">
                    {it.status === 'pending' && (
                      <>
                        <Spinner /> 识别中…
                      </>
                    )}
                    {it.status === 'ok' && (
                      <>
                        <Icon name="check" size={12} /> {it.texts.length > 1 ? `识别到 ${it.texts.length} 个二维码` : '已识别'}
                      </>
                    )}
                    {it.status === 'none' && '未识别'}
                  </span>
                </span>
                <button type="button" className="cz-2fa-ib" aria-label="移除" onClick={() => remove(it.id)}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorLine error={error} />
      </div>
      <div className="cz-2fa-imp__foot">
        <span className="cz-2fa-imp__foot-note">{items.length > 0 && !pending ? `${okCount} / ${items.length} 张已识别` : ''}</span>
        <button
          type="button"
          className="cz-2fa-btn is-primary"
          disabled={busy || pending || allTexts.length === 0}
          onClick={() => void submitText(allTexts.join('\n'))}
        >
          {busy ? '解析中…' : '下一步'}
        </button>
      </div>
    </>
  );
}

// ───────────────────────── 来源：链接 ─────────────────────────

function LinkSource({ busy, error, setError, submitText }: SourceProps & { onBack: () => void }) {
  const [value, setValue] = useState('');
  const pastedRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => taRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, []);

  const parse = (text = value) => {
    if (!text.trim()) return;
    void submitText(text);
  };

  return (
    <>
      <div className="cz-2fa-imp__body">
        <label className="cz-2fa-field">
          <span className="cz-2fa-label">粘贴 OTP 链接（每行一条）</span>
          <textarea
            ref={taRef}
            className="cz-2fa-imp__ta"
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder={'otpauth://totp/...\notpauth-migration://offline?data=...'}
            onPaste={() => {
              pastedRef.current = true;
            }}
            onChange={(e) => {
              const v = e.target.value;
              setValue(v);
              if (error) setError(null);
              if (pastedRef.current) {
                pastedRef.current = false;
                if (/otpauth(-migration)?:\/\//i.test(v)) parse(v);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                parse();
              }
            }}
          />
        </label>
        <p className="cz-2fa-imp__tip">
          支持单个 <code>otpauth://</code> 链接，以及 Google Authenticator「导出账号」生成的 <code>otpauth-migration://</code> 链接。粘贴后会自动解析。
        </p>
        <ErrorLine error={error} />
      </div>
      <div className="cz-2fa-imp__foot">
        <span className="cz-2fa-imp__foot-note">{value.trim() ? '' : 'Ctrl+Enter 解析'}</span>
        <button type="button" className="cz-2fa-btn is-primary" disabled={busy || !value.trim()} onClick={() => parse()}>
          {busy ? '解析中…' : '解析'}
        </button>
      </div>
    </>
  );
}

// ───────────────────────── 来源：备份文件 ─────────────────────────

function BackupSource({ busy, error, setError, submitText }: SourceProps & { onBack: () => void }) {
  const [over, setOver] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BACKUP_BYTES) {
      setError('文件过大，备份文件通常不超过几百 KB');
      return;
    }
    setError(null);
    setName(f.name);
    let text = '';
    try {
      text = await f.text();
    } catch {
      setError('读取文件失败');
      return;
    }
    if (!text.trim()) {
      setError('文件是空的');
      return;
    }
    await submitText(text);
  };

  return (
    <>
      <div className="cz-2fa-imp__body">
        <div
          className={`cz-2fa-imp__drop${over ? ' is-over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            depth.current++;
            setOver(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            depth.current = 0;
            setOver(false);
            void readFile(e.dataTransfer.files[0]);
          }}
        >
          <span className="cz-2fa-imp__drop-ic">{busy ? <Spinner /> : <FileGlyph size={30} />}</span>
          <span className="cz-2fa-imp__drop-title">
            {busy ? '正在解析…' : over ? '松开即可读取' : name ? name : '点击选择备份文件，或拖到这里'}
          </span>
          <span className="cz-2fa-imp__drop-desc">支持 .json / .txt</span>
          <input
            ref={inputRef}
            type="file"
            accept=".json,.txt,.csv,application/json,text/plain"
            className="cz-2fa-hidden-file"
            onChange={(e) => {
              void readFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <ul className="cz-2fa-imp__formats">
          <li>
            <span className="cz-2fa-imp__fmt-dot" />
            Authenticator / authenticator.cc 导出的备份（JSON）
          </li>
          <li>
            <span className="cz-2fa-imp__fmt-dot" />
            每行一个 <code>otpauth://</code> 链接的文本文件
          </li>
        </ul>
        <ErrorLine error={error} />
      </div>
    </>
  );
}

// ───────────────────────── 预览步骤 ─────────────────────────

function itemMeta(it: TwoFaImportPreviewItem): string {
  const parts: string[] = [];
  if (it.algorithm !== 'SHA1') parts.push(it.algorithm);
  if (it.digits !== 6) parts.push(`${it.digits} 位`);
  if (it.period !== 30) parts.push(`${it.period}s`);
  return parts.join(' · ');
}

function PreviewStep({
  preview,
  groups,
  defaultGroupId,
  importText,
  onEdit,
  onDone,
}: {
  preview: PreviewState;
  groups: TwoFaGroup[];
  defaultGroupId: string | null;
  importText: (input: TwoFaImportInput) => Promise<TwoFaImportResult>;
  onEdit: () => void;
  onDone: (r: TwoFaImportResult) => void;
}) {
  const { items, unsupported, errors } = preview.result;
  const [checked, setChecked] = useState<Set<number>>(() => new Set(items.filter((i) => !i.duplicate).map((i) => i.index)));
  const [groupId, setGroupId] = useState<string | null>(defaultGroupId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dupCount = items.filter((i) => i.duplicate).length;
  const selectable = items.filter((i) => !i.duplicate);
  const allOn = selectable.length > 0 && selectable.every((i) => checked.has(i.index));
  const n = items.filter((i) => checked.has(i.index) && !i.duplicate).length;

  const toggle = (idx: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  const submit = async () => {
    if (busy || n === 0) return;
    setBusy(true);
    setError(null);
    try {
      const exclude = items.filter((i) => !checked.has(i.index) || i.duplicate).map((i) => i.index);
      const res = await importText({ text: preview.text, groupId, exclude });
      onDone(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
      setBusy(false);
    }
  };

  return (
    <div className="cz-2fa-imp__step is-preview">
      <div className="cz-2fa-imp__sum">
        <div className="cz-2fa-imp__sum-chips">
          <span className="cz-2fa-imp__stat is-ok">可导入 <b>{selectable.length}</b></span>
          {dupCount > 0 && <span className="cz-2fa-imp__stat is-dup">重复 <b>{dupCount}</b></span>}
          {unsupported > 0 && <span className="cz-2fa-imp__stat is-bad">不支持 <b>{unsupported}</b></span>}
        </div>
        {selectable.length > 1 && (
          <button
            type="button"
            className="cz-2fa-imp__link"
            onClick={() => setChecked(allOn ? new Set() : new Set(selectable.map((i) => i.index)))}
          >
            {allOn ? '全不选' : '全选'}
          </button>
        )}
      </div>
      {errors.length > 0 && (
        <div className="cz-2fa-imp__warn" title={errors.join('\n')}>
          <Icon name="info" size={12} />
          <span>{errors[0]}{errors.length > 1 ? `（另有 ${errors.length - 1} 条）` : ''}</span>
        </div>
      )}

      <div className="cz-2fa-imp__list" role="list">
        {items.map((it, i) => {
          const on = checked.has(it.index) && !it.duplicate;
          const meta = itemMeta(it);
          const name = it.issuer || it.account || '未命名';
          return (
            <label
              key={it.index}
              role="listitem"
              className={`cz-2fa-imp__item${on ? ' is-on' : ''}${it.duplicate ? ' is-dup' : ''}`}
              style={{ animationDelay: `${Math.min(i, 12) * 22}ms` }}
            >
              <input type="checkbox" className="cz-2fa-imp__cb-in" checked={on} disabled={it.duplicate} onChange={() => toggle(it.index)} />
              <span className="cz-2fa-imp__cb" aria-hidden="true">
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.4 6.4 4.9 8.8 9.6 3.4" />
                </svg>
              </span>
              <span className={`cz-2fa-av is-c-${issuerColorKey(name)}`} aria-hidden="true">
                {issuerInitial(it.issuer, it.account)}
              </span>
              <span className="cz-2fa-imp__item-tx">
                <span className="cz-2fa-imp__item-top">
                  <span className="cz-2fa-imp__item-issuer" title={name}>{name}</span>
                  {it.duplicate && <span className="cz-2fa-imp__badge">已存在</span>}
                  {meta && <span className="cz-2fa-imp__meta">{meta}</span>}
                </span>
                {it.account && <span className="cz-2fa-imp__item-acc" title={it.account}>{it.account}</span>}
              </span>
            </label>
          );
        })}
      </div>

      <div className="cz-2fa-imp__target">
        <span className="cz-2fa-label">导入到</span>
        <GroupPicker groups={groups} value={groupId} onChange={setGroupId} disabled={busy} aria-label="导入到分组" />
      </div>
      {error && <div className="cz-2fa-imp__err is-pad"><Icon name="info" size={13} /><span>{error}</span></div>}

      <div className="cz-2fa-imp__foot">
        <button type="button" className="cz-2fa-btn" onClick={onEdit} disabled={busy}>返回修改</button>
        <button type="button" className="cz-2fa-btn is-primary" onClick={() => void submit()} disabled={busy || n === 0}>
          {busy ? '导入中…' : n > 0 ? `导入 ${n} 条` : '没有可导入的条目'}
        </button>
      </div>
    </div>
  );
}
