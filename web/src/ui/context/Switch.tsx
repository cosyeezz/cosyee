// 开关（role=switch）；样式见 ContextPanel.css 的 .cz-ctx__switch
export function Switch({
  on, label, title, disabled, onChange,
}: {
  on: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      className={`cz-ctx__switch${on ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="cz-ctx__knob" />
    </button>
  );
}
