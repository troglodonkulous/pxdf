/* @ds-bundle: {"format":4,"namespace":"PxdfDesignSystem_fee2c8","components":[{"name":"Segmented","sourcePath":"components/controls/Segmented.jsx"},{"name":"Select","sourcePath":"components/controls/Select.jsx"},{"name":"Slider","sourcePath":"components/controls/Slider.jsx"},{"name":"Stepper","sourcePath":"components/controls/Stepper.jsx"},{"name":"Switch","sourcePath":"components/controls/Switch.jsx"},{"name":"TextField","sourcePath":"components/controls/TextField.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Panel","sourcePath":"components/core/Panel.jsx"},{"name":"SectionLabel","sourcePath":"components/core/SectionLabel.jsx"},{"name":"StatusPill","sourcePath":"components/core/StatusPill.jsx"},{"name":"KeyValue","sourcePath":"components/data/KeyValue.jsx"},{"name":"ListRow","sourcePath":"components/data/ListRow.jsx"},{"name":"StatReadout","sourcePath":"components/data/StatReadout.jsx"},{"name":"Timecode","sourcePath":"components/data/Timecode.jsx"},{"name":"ControllerChip","sourcePath":"components/floor/ControllerChip.jsx"},{"name":"FloorPreview","sourcePath":"components/floor/FloorPreview.jsx"},{"name":"TransportBar","sourcePath":"components/floor/TransportBar.jsx"}],"sourceHashes":{"components/controls/Segmented.jsx":"f6035999c8d7","components/controls/Select.jsx":"421eee160779","components/controls/Slider.jsx":"b9b8525a578c","components/controls/Stepper.jsx":"f99c5314b57e","components/controls/Switch.jsx":"dcb82a5e70ec","components/controls/TextField.jsx":"41f6c7b650f1","components/core/Badge.jsx":"1750d0737560","components/core/Button.jsx":"af691156c341","components/core/Icon.jsx":"f27767a573f2","components/core/IconButton.jsx":"93ec2a1f01bc","components/core/Panel.jsx":"0364f53b7c36","components/core/SectionLabel.jsx":"f0bc9205a180","components/core/StatusPill.jsx":"acd6d790133b","components/data/KeyValue.jsx":"655ebc837a42","components/data/ListRow.jsx":"3f2bcfb60d03","components/data/StatReadout.jsx":"0fc43ff4927b","components/data/Timecode.jsx":"68205cde2fdc","components/floor/ControllerChip.jsx":"7f2fe0c617ce","components/floor/FloorPreview.jsx":"39f8439f6f05","components/floor/TransportBar.jsx":"9d6f1da911fe","ui_kits/ddf-mac/edit.jsx":"b4e3e8438ab9","ui_kits/ddf-mac/mapping.jsx":"5323281b3034","ui_kits/ddf-mac/play.jsx":"605bd649bb62"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.PxdfDesignSystem_fee2c8 = window.PxdfDesignSystem_fee2c8 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/controls/Segmented.jsx
try { (() => {
function Segmented({
  options = [],
  value,
  onChange,
  style
}) {
  return React.createElement('div', {
    style: Object.assign({
      display: 'inline-flex',
      gap: '4px'
    }, style)
  }, options.map(o => {
    const active = o === value;
    return React.createElement('button', {
      key: o,
      onClick: () => onChange && onChange(o),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 'var(--fs-caption)',
        fontWeight: 500,
        fontFamily: 'var(--font-ui)',
        padding: '6px 12px',
        borderRadius: 'var(--r-md)',
        border: 'none',
        cursor: 'pointer',
        background: active ? 'var(--surface-raised)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        transition: 'background var(--dur-fast) var(--ease-out),color var(--dur-fast) var(--ease-out)'
      }
    }, React.createElement('span', {
      style: {
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: active ? 'var(--pxdf-green-hot)' : 'var(--n-6)',
        boxShadow: active ? 'var(--glow-accent)' : 'none',
        transition: 'background var(--dur-fast) var(--ease-out)'
      }
    }), o);
  }));
}
Object.assign(__ds_scope, { Segmented });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Segmented.jsx", error: String((e && e.message) || e) }); }

// components/controls/Slider.jsx
try { (() => {
let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style');
  s.textContent = '.pxdf-slider::-webkit-slider-thumb{-webkit-appearance:none;width:8px;height:18px;border-radius:3px;background:var(--n-11);box-shadow:0 1px 3px rgba(0,0,0,.5);cursor:pointer}.pxdf-slider::-moz-range-thumb{width:8px;height:18px;border:none;border-radius:3px;background:var(--n-11);cursor:pointer}.pxdf-slider.acc::-webkit-slider-thumb{background:var(--pxdf-green-glow);box-shadow:0 0 10px oklch(0.82 0.20 148 / 0.65)}.pxdf-slider.acc::-moz-range-thumb{background:var(--pxdf-green-glow)}';
  document.head.appendChild(s);
}
// Segmented LED fader — the track is a strip of lit cells, console-style.
function Slider({
  value = 50,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  accent = false,
  width = 120,
  style
}) {
  ensureCss();
  const pct = (value - min) / (max - min) * 100;
  const fill = accent ? 'var(--pxdf-green-hot)' : 'var(--n-10)';
  return React.createElement('input', {
    type: 'range',
    className: 'pxdf-slider' + (accent ? ' acc' : ''),
    value,
    min,
    max,
    step,
    onChange: e => onChange && onChange(+e.target.value),
    style: Object.assign({
      WebkitAppearance: 'none',
      appearance: 'none',
      width,
      height: 10,
      borderRadius: 2,
      outline: 'none',
      margin: 0,
      background: 'repeating-linear-gradient(90deg,transparent 0 5px,var(--surface-window) 5px 7px),linear-gradient(to right,' + fill + ' ' + pct + '%,var(--led-cell-off) ' + pct + '%)'
    }, style)
  });
}
Object.assign(__ds_scope, { Slider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Slider.jsx", error: String((e && e.message) || e) }); }

// components/controls/Switch.jsx
try { (() => {
function Switch({
  checked = false,
  onChange,
  disabled = false,
  style
}) {
  return React.createElement('button', {
    onClick: disabled ? undefined : () => onChange && onChange(!checked),
    style: Object.assign({
      width: 34,
      height: 20,
      borderRadius: 'var(--r-pill)',
      border: 'none',
      padding: 2,
      cursor: disabled ? 'default' : 'pointer',
      background: checked ? 'var(--pxdf-green-hot)' : 'var(--n-5)',
      opacity: disabled ? 0.4 : 1,
      display: 'inline-flex',
      boxShadow: checked ? '0 0 10px oklch(0.82 0.20 148 / 0.40)' : 'none',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      transition: 'background var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)'
    }, style)
  }, React.createElement('span', {
    style: {
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: 'var(--n-11)',
      boxShadow: '0 1px 2px rgba(0,0,0,0.4)'
    }
  }));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Switch.jsx", error: String((e && e.message) || e) }); }

// components/controls/TextField.jsx
try { (() => {
function TextField({
  value,
  placeholder,
  onChange,
  mono = false,
  width = 150,
  disabled = false,
  style
}) {
  const [focus, setFocus] = React.useState(false);
  return React.createElement('input', {
    value,
    placeholder,
    disabled,
    onChange: e => onChange && onChange(e.target.value),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: Object.assign({
      width,
      height: 'var(--h-control)',
      boxSizing: 'border-box',
      background: 'var(--surface-well)',
      color: 'var(--text-primary)',
      border: '1px solid ' + (focus ? 'var(--border-accent)' : 'var(--border-hairline)'),
      borderRadius: 'var(--r-md)',
      padding: '0 10px',
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
      fontSize: 'var(--fs-body)',
      outline: 'none',
      boxShadow: focus ? '0 0 0 3px var(--focus-ring)' : 'none',
      opacity: disabled ? 0.4 : 1,
      transition: 'border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)'
    }, style)
  });
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/TextField.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function Badge({
  children,
  tone = 'neutral',
  style
}) {
  const t = tone === 'accent' ? {
    background: 'var(--pxdf-green-hot)',
    color: 'var(--text-on-accent)',
    boxShadow: '0 0 12px oklch(0.82 0.20 148 / 0.35)'
  } : {
    background: 'var(--surface-raised)',
    color: 'var(--text-secondary)'
  };
  return React.createElement('span', {
    style: Object.assign({
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-caption)',
      fontWeight: 600,
      padding: '4px 9px',
      borderRadius: 'var(--r-xs)',
      letterSpacing: '0.02em'
    }, t, style)
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function Button({
  variant = 'secondary',
  size = 'md',
  children,
  disabled = false,
  onClick,
  style
}) {
  const [hov, setHov] = React.useState(false);
  const [prs, setPrs] = React.useState(false);
  const v = {
    primary: {
      background: hov && !disabled ? 'oklch(0.85 0.20 148)' : 'var(--pxdf-green-hot)',
      color: 'var(--text-on-accent)',
      fontWeight: 600
    },
    secondary: {
      background: hov && !disabled ? 'var(--n-5)' : 'var(--surface-raised)',
      color: 'var(--text-primary)',
      fontWeight: 500
    },
    ghost: {
      background: hov && !disabled ? 'var(--surface-raised)' : 'transparent',
      color: hov && !disabled ? 'var(--text-primary)' : 'var(--text-secondary)',
      fontWeight: 500,
      border: '1px solid var(--border-hairline)'
    }
  }[variant];
  return React.createElement('button', {
    onClick: disabled ? undefined : onClick,
    disabled,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => {
      setHov(false);
      setPrs(false);
    },
    onMouseDown: () => setPrs(true),
    onMouseUp: () => setPrs(false),
    style: Object.assign({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      height: size === 'sm' ? 'var(--h-control)' : 'var(--h-control-lg)',
      padding: size === 'sm' ? '0 12px' : '0 16px',
      border: 'none',
      borderRadius: 'var(--r-md)',
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--fs-body)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      userSelect: 'none',
      transform: prs && !disabled ? 'scale(var(--press-scale))' : 'none',
      transition: 'background var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out)'
    }, v, style)
  }, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
// Lucide (CDN) stand-in for SF Symbols — see readme.md "Iconography".
function Icon({
  name,
  size = 15,
  strokeWidth = 1.75,
  color = 'currentColor',
  style
}) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const l = window.lucide;
    if (!l || !ref.current) return;
    const key = name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
    const node = (l.icons || {})[key];
    if (!node) return;
    ref.current.innerHTML = '';
    const svg = l.createElement(node);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('stroke-width', strokeWidth);
    ref.current.appendChild(svg);
  }, [name, size, strokeWidth]);
  return React.createElement('span', {
    ref,
    style: Object.assign({
      display: 'inline-flex',
      width: size,
      height: size,
      color,
      flex: 'none'
    }, style)
  });
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/controls/Select.jsx
try { (() => {
function Select({
  options = [],
  value,
  onChange,
  width = 150,
  disabled = false,
  style
}) {
  return React.createElement('span', {
    style: Object.assign({
      position: 'relative',
      display: 'inline-flex',
      width
    }, style)
  }, React.createElement('select', {
    value,
    disabled,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      appearance: 'none',
      WebkitAppearance: 'none',
      width: '100%',
      height: 'var(--h-control)',
      background: 'var(--surface-raised)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--r-md)',
      padding: '0 26px 0 10px',
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--fs-body)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1
    }
  }, options.map(o => React.createElement('option', {
    key: o,
    value: o
  }, o))), React.createElement(__ds_scope.Icon, {
    name: 'chevron-down',
    size: 13,
    style: {
      position: 'absolute',
      right: 8,
      top: '50%',
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
      color: 'var(--text-muted)'
    }
  }));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Select.jsx", error: String((e && e.message) || e) }); }

// components/controls/Stepper.jsx
try { (() => {
function Stepper({
  value = 0,
  min = -Infinity,
  max = Infinity,
  step = 1,
  onChange,
  suffix = '',
  width = 110,
  style
}) {
  const btn = (icon, d) => React.createElement('button', {
    onClick: () => onChange && onChange(Math.min(max, Math.max(min, value + d))),
    style: {
      width: 26,
      height: 'var(--h-control)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      background: 'var(--surface-raised)',
      color: 'var(--text-secondary)',
      cursor: 'pointer'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 12
  }));
  return React.createElement('span', {
    style: Object.assign({
      display: 'inline-flex',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--r-md)',
      overflow: 'hidden',
      width
    }, style)
  }, btn('minus', -step), React.createElement('span', {
    style: {
      flex: 1,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--surface-well)',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-caption)',
      color: 'var(--text-numeric)'
    }
  }, value + suffix), btn('plus', step));
}
Object.assign(__ds_scope, { Stepper });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Stepper.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function IconButton({
  icon,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  onClick,
  title,
  style
}) {
  const [hov, setHov] = React.useState(false);
  const dim = size === 'lg' ? 44 : 34;
  const primary = variant === 'primary';
  return React.createElement('button', {
    onClick: disabled ? undefined : onClick,
    disabled,
    title,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: Object.assign({
      width: dim,
      height: dim,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: size === 'lg' ? 'var(--r-2xl)' : 'var(--r-lg)',
      cursor: disabled ? 'default' : 'pointer',
      background: primary ? hov ? 'oklch(0.85 0.20 148)' : 'var(--pxdf-green-hot)' : hov && !disabled ? 'var(--n-5)' : 'var(--surface-raised)',
      color: primary ? 'var(--text-on-accent)' : hov ? 'var(--text-primary)' : 'var(--text-secondary)',
      boxShadow: primary ? 'var(--glow-accent-lg)' : 'none',
      opacity: disabled ? 0.4 : 1,
      transition: 'background var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)'
    }, style)
  }, React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === 'lg' ? 18 : 15
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/SectionLabel.jsx
try { (() => {
function SectionLabel({
  children,
  style
}) {
  return React.createElement('div', {
    style: Object.assign({
      fontSize: 'var(--fs-label)',
      letterSpacing: 'var(--ls-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      fontWeight: 600,
      fontFamily: 'var(--font-ui)'
    }, style)
  }, children);
}
Object.assign(__ds_scope, { SectionLabel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SectionLabel.jsx", error: String((e && e.message) || e) }); }

// components/core/Panel.jsx
try { (() => {
function Panel({
  title,
  inset = false,
  children,
  pad = 'var(--pad-panel)',
  style
}) {
  const insetTex = inset ? {
    backgroundImage: 'radial-gradient(circle,oklch(0.205 0.012 152) 1px,transparent 1.4px)',
    backgroundSize: '9px 9px'
  } : {};
  return React.createElement('div', {
    style: Object.assign({
      background: inset ? 'var(--surface-well)' : 'var(--surface-card)',
      border: '1px solid ' + (inset ? 'var(--border-well)' : 'var(--border-hairline)'),
      borderRadius: 'var(--r-xl)',
      padding: pad,
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      boxShadow: inset ? 'inset 0 2px 8px rgba(0,0,0,0.35)' : 'none'
    }, insetTex, style)
  }, title ? React.createElement(__ds_scope.SectionLabel, null, title) : null, children);
}
Object.assign(__ds_scope, { Panel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Panel.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusPill.jsx
try { (() => {
let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style');
  s.textContent = '@keyframes pxdfPulse{0%,100%{opacity:1}50%{opacity:0.45}}';
  document.head.appendChild(s);
}
function StatusPill({
  label,
  tone = 'ok',
  glow = true,
  style
}) {
  ensureCss();
  const tones = {
    ok: {
      bg: 'var(--surface-accent-soft)',
      fg: 'oklch(0.86 0.16 148)',
      dot: 'var(--pxdf-green-glow)'
    },
    warn: {
      bg: 'oklch(0.30 0.06 85)',
      fg: 'oklch(0.86 0.14 85)',
      dot: 'oklch(0.82 0.16 85)'
    },
    danger: {
      bg: 'oklch(0.28 0.08 27)',
      fg: 'oklch(0.80 0.14 27)',
      dot: 'oklch(0.68 0.19 27)'
    },
    idle: {
      bg: 'var(--surface-raised)',
      fg: 'var(--text-secondary)',
      dot: 'var(--sem-idle)'
    }
  }[tone];
  return React.createElement('span', {
    style: Object.assign({
      display: 'inline-flex',
      alignItems: 'center',
      gap: '7px',
      padding: '5px 11px',
      borderRadius: 'var(--r-pill)',
      background: tones.bg,
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--fs-label)',
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: tones.fg
    }, style)
  }, React.createElement('span', {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: tones.dot,
      boxShadow: glow && tone !== 'idle' ? '0 0 8px ' + tones.dot : 'none',
      animation: glow && tone !== 'idle' ? 'pxdfPulse 2.4s var(--ease-inout) infinite' : 'none'
    }
  }), label);
}
Object.assign(__ds_scope, { StatusPill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusPill.jsx", error: String((e && e.message) || e) }); }

// components/data/KeyValue.jsx
try { (() => {
function KeyValue({
  label,
  value,
  style
}) {
  return React.createElement('div', {
    style: Object.assign({
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: '12px',
      fontSize: 'var(--fs-label)'
    }, style)
  }, React.createElement('span', {
    style: {
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-ui)'
    }
  }, label), React.createElement('span', {
    style: {
      fontFamily: 'var(--font-mono)',
      color: 'var(--text-body)'
    }
  }, value));
}
Object.assign(__ds_scope, { KeyValue });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/KeyValue.jsx", error: String((e && e.message) || e) }); }

// components/data/ListRow.jsx
try { (() => {
let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style');
  s.textContent = '@keyframes pxdfEq{0%,100%{transform:scaleY(0.25)}50%{transform:scaleY(1)}}';
  document.head.appendChild(s);
}
function ListRow({
  index,
  title,
  meta,
  selected = false,
  active = false,
  onClick,
  style
}) {
  ensureCss();
  const [hov, setHov] = React.useState(false);
  const dim = selected ? 'oklch(0.32 0.09 148)' : 'var(--text-muted)';
  return React.createElement('div', {
    onClick,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: Object.assign({
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '11px 12px',
      borderRadius: 'var(--r-lg)',
      cursor: onClick ? 'pointer' : 'default',
      background: selected ? 'var(--surface-selected)' : hov ? 'var(--n-3)' : 'transparent',
      boxShadow: selected ? '0 0 16px oklch(0.82 0.20 148 / 0.28)' : 'none',
      transition: 'background var(--dur-fast) var(--ease-out),box-shadow var(--dur-base) var(--ease-out)'
    }, style)
  }, index != null ? React.createElement('span', {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-caption)',
      fontWeight: selected ? 600 : 400,
      color: dim
    }
  }, index) : null, React.createElement('span', {
    style: {
      flex: 1,
      fontSize: 'var(--fs-body-lg)',
      fontFamily: 'var(--font-ui)',
      fontWeight: selected ? 600 : 400,
      color: selected ? 'var(--text-on-accent)' : 'var(--text-body)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, title), active ? React.createElement('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'flex-end',
      gap: 2,
      height: 12,
      color: selected ? 'var(--text-on-accent)' : 'var(--pxdf-green-hot)'
    }
  }, [0, 1, 2].map(i => React.createElement('span', {
    key: i,
    style: {
      width: 2.5,
      height: 12,
      background: 'currentColor',
      borderRadius: 1,
      transformOrigin: 'bottom',
      animation: 'pxdfEq ' + (0.7 + i * 0.13) + 's var(--ease-inout) ' + i * 0.18 + 's infinite'
    }
  }))) : null, meta != null ? React.createElement('span', {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-caption)',
      color: dim
    }
  }, meta) : null);
}
Object.assign(__ds_scope, { ListRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/ListRow.jsx", error: String((e && e.message) || e) }); }

// components/data/StatReadout.jsx
try { (() => {
function StatReadout({
  label,
  value,
  unit,
  accent = false,
  style
}) {
  return React.createElement('div', {
    style: Object.assign({
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    }, style)
  }, React.createElement('span', {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-ui)'
    }
  }, label), React.createElement('span', {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-readout)',
      fontWeight: 500,
      color: accent ? 'var(--pxdf-green-hot)' : 'var(--text-numeric)'
    }
  }, value, unit ? React.createElement('span', {
    style: {
      fontSize: 'var(--fs-caption)',
      color: accent ? 'oklch(0.60 0.05 148)' : 'var(--text-muted)'
    }
  }, ' ' + unit) : null));
}
Object.assign(__ds_scope, { StatReadout });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/StatReadout.jsx", error: String((e && e.message) || e) }); }

// components/data/Timecode.jsx
try { (() => {
function Timecode({
  current,
  total,
  size = 'var(--fs-body)',
  style
}) {
  return React.createElement('span', {
    style: Object.assign({
      fontFamily: 'var(--font-mono)',
      fontSize: size,
      color: 'var(--text-numeric)'
    }, style)
  }, current, total ? React.createElement('span', {
    style: {
      color: 'var(--text-muted)'
    }
  }, ' / ' + total) : null);
}
Object.assign(__ds_scope, { Timecode });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Timecode.jsx", error: String((e && e.message) || e) }); }

// components/floor/ControllerChip.jsx
try { (() => {
function ControllerChip({
  label,
  ports = 4,
  activePorts,
  style
}) {
  const active = activePorts == null ? ports : activePorts;
  const jacks = [];
  for (let i = 0; i < ports; i++) {
    const on = i < active;
    jacks.push(React.createElement('span', {
      key: i,
      style: {
        width: 11,
        height: 9,
        borderRadius: 2,
        background: on ? 'var(--pxdf-green-hot)' : 'transparent',
        border: '1.5px solid ' + (on ? 'var(--pxdf-green-hot)' : 'var(--n-6)'),
        boxShadow: on ? 'var(--glow-accent)' : 'none',
        boxSizing: 'border-box'
      }
    }));
  }
  return React.createElement('div', {
    style: Object.assign({
      display: 'inline-flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '7px 10px',
      background: 'var(--surface-chrome)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--r-sm)',
      borderTop: '1px solid var(--n-6)'
    }, style)
  }, React.createElement('span', {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8
    }
  }, React.createElement('span', {
    style: {
      fontSize: 'var(--fs-micro)',
      fontWeight: 600,
      color: 'var(--text-secondary)',
      fontFamily: 'var(--font-ui)',
      letterSpacing: '0.04em'
    }
  }, label), React.createElement('span', {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 9,
      color: 'var(--text-muted)'
    }
  }, active + '/' + ports)), React.createElement('span', {
    style: {
      display: 'flex',
      gap: '6px'
    }
  }, jacks));
}
Object.assign(__ds_scope, { ControllerChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/floor/ControllerChip.jsx", error: String((e && e.message) || e) }); }

// components/floor/FloorPreview.jsx
try { (() => {
// Live render of the LED floor. The only continuously-animated, fully-chromatic element in the app.
function FloorPreview({
  cols = 12,
  rows = 8,
  gap = 4,
  radius = 3,
  hue = 148,
  chroma = 0.22,
  floorL = 0.15,
  animated = true,
  cells,
  style
}) {
  const [t, setT] = React.useState(0);
  React.useEffect(() => {
    if (!animated || cells) return;
    let raf,
      start = performance.now();
    const tick = now => {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animated, cells]);
  const cx = (cols - 1) / 2,
    cy = (rows - 1) / 2;
  const arr = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let col;
    if (cells && cells[y] && cells[y][x] != null) {
      col = cells[y][x];
    } else {
      const dx = (x - cx) / cols * 2,
        dy = (y - cy) / rows * 2;
      const d = Math.hypot(dx, dy),
        a = Math.atan2(dy, dx);
      const w = 0.5 + 0.5 * Math.sin(d * 6 - t * 2.2 + 1.4 * Math.sin(a * 3 + t * 0.7));
      const L = floorL + w * 0.55,
        C = chroma * (0.35 + 0.65 * w),
        H = hue + 12 * Math.sin(t * 0.35 + d * 2);
      col = 'oklch(' + L.toFixed(3) + ' ' + C.toFixed(3) + ' ' + H.toFixed(1) + ')';
    }
    arr.push(React.createElement('div', {
      key: x + '_' + y,
      style: {
        background: col,
        borderRadius: radius,
        aspectRatio: '1'
      }
    }));
  }
  return React.createElement('div', {
    style: Object.assign({
      display: 'grid',
      gridTemplateColumns: 'repeat(' + cols + ',1fr)',
      gap,
      width: '100%'
    }, style)
  }, arr);
}
Object.assign(__ds_scope, { FloorPreview });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/floor/FloorPreview.jsx", error: String((e && e.message) || e) }); }

// components/floor/TransportBar.jsx
try { (() => {
function TransportBar({
  playing = true,
  onPlay,
  onPrev,
  onNext,
  current = '00:00',
  total,
  progress = 0,
  master = 82,
  onMaster,
  style
}) {
  const N = 40,
    lit = Math.round(Math.max(0, Math.min(1, progress)) * N);
  const strip = [];
  for (let i = 0; i < N; i++) {
    const on = i < lit,
      head = i === lit - 1;
    strip.push(React.createElement('span', {
      key: i,
      style: {
        flex: 1,
        height: head ? 12 : on ? 10 : 6,
        borderRadius: 1,
        alignSelf: 'center',
        background: head ? 'var(--pxdf-green-glow)' : on ? 'var(--pxdf-green-hot)' : 'var(--led-cell-off)',
        boxShadow: head ? 'var(--glow-accent)' : 'none',
        transition: 'height var(--dur-fast) var(--ease-out)'
      }
    }));
  }
  return React.createElement('div', {
    style: Object.assign({
      height: 'var(--h-transport)',
      borderTop: '1px solid var(--border-hairline)',
      background: 'var(--surface-chrome)',
      display: 'flex',
      alignItems: 'center',
      gap: '22px',
      padding: '0 24px',
      boxSizing: 'border-box'
    }, style)
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    }
  }, React.createElement(__ds_scope.IconButton, {
    icon: 'rewind',
    onClick: onPrev,
    title: 'Previous cue'
  }), React.createElement(__ds_scope.IconButton, {
    icon: playing ? 'pause' : 'play',
    variant: 'primary',
    size: 'lg',
    onClick: onPlay,
    title: playing ? 'Pause' : 'Play'
  }), React.createElement(__ds_scope.IconButton, {
    icon: 'fast-forward',
    onClick: onNext,
    title: 'Next cue'
  })), React.createElement(__ds_scope.Timecode, {
    current,
    total
  }), React.createElement('div', {
    style: {
      flex: 1,
      display: 'flex',
      gap: 2,
      height: 14
    }
  }, strip), React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '11px'
    }
  }, React.createElement(__ds_scope.SectionLabel, {
    style: {
      letterSpacing: '0.1em'
    }
  }, 'Master'), React.createElement(__ds_scope.Slider, {
    value: master,
    onChange: onMaster,
    width: 96
  }), React.createElement('span', {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-body)',
      color: 'var(--text-numeric)',
      width: 34
    }
  }, master + '%')));
}
Object.assign(__ds_scope, { TransportBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/floor/TransportBar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ddf-mac/edit.jsx
try { (() => {
function EditScreen({
  playing
}) {
  const {
    Panel,
    SectionLabel,
    Button,
    Icon,
    Slider,
    Segmented,
    KeyValue,
    FloorPreview,
    Timecode
  } = window.PxdfDesignSystem_fee2c8;
  const tools = ['mouse-pointer', 'hand', 'zoom-in', '|', 'crop', 'move', 'maximize', '|', 'square', 'pen-tool', 'type', '|', 'brush', 'stamp', 'eraser', '|', 'wand-2', 'pin'];
  const [tool, setTool] = React.useState('mouse-pointer');
  const files = ['firefly.mp4', 'sparkles.mp4', 'blobs.mov', 'snowflakes.avi'];
  const [file, setFile] = React.useState(0);
  const clips = [{
    layer: 4,
    color: 'var(--layer-4)',
    l: 52,
    w: 24,
    name: 'sparkles.mp4'
  }, {
    layer: 3,
    color: 'var(--layer-3)',
    l: 28,
    w: 62,
    name: 'blobs.mov'
  }, {
    layer: 2,
    color: 'var(--layer-2)',
    l: 2,
    w: 26,
    name: 'snowflakes.avi'
  }, {
    layer: 1,
    color: 'var(--layer-1)',
    l: 2,
    w: 88,
    name: 'firefly.mp4'
  }];
  const [selClip, setSelClip] = React.useState(3);
  const [opacity, setOpacity] = React.useState(100);
  const [blend, setBlend] = React.useState('Normal');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      flex: 'none',
      borderBottom: '1px solid var(--border-hairline)',
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      padding: '0 14px',
      background: 'var(--surface-chrome)'
    }
  }, tools.map((t, i) => t === '|' ? /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      width: 1,
      height: 20,
      background: 'var(--border-hairline)',
      margin: '0 6px'
    }
  }) : /*#__PURE__*/React.createElement("button", {
    key: t,
    onClick: () => setTool(t),
    title: t,
    style: {
      width: 30,
      height: 30,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: 'var(--r-sm)',
      cursor: 'pointer',
      background: tool === t ? 'var(--surface-raised)' : 'transparent',
      color: tool === t ? 'var(--pxdf-green-hot)' : 'var(--text-secondary)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: t,
    size: 14
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'var(--w-sidebar)',
      flex: 'none',
      borderRight: '1px solid var(--border-hairline)',
      padding: '18px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Media"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-micro)',
      color: 'var(--text-muted)'
    }
  }, "Quick Preview"), /*#__PURE__*/React.createElement(Panel, {
    inset: true,
    pad: "10px"
  }, /*#__PURE__*/React.createElement(FloorPreview, {
    cols: 10,
    rows: 5,
    gap: 2,
    radius: 2,
    animated: false,
    hue: 210,
    chroma: 0.14,
    floorL: 0.3
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-hairline)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-micro)',
      color: 'var(--text-muted)'
    }
  }, "File Browser"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      fontSize: 'var(--fs-caption)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '5px 6px',
      color: 'var(--text-secondary)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "folder",
    size: 13
  }), " Documents"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '5px 6px 5px 20px',
      color: 'var(--text-secondary)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "folder-open",
    size: 13
  }), " PXDF Media"), files.map((f, i) => /*#__PURE__*/React.createElement("div", {
    key: f,
    onClick: () => setFile(i),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '5px 6px 5px 36px',
      borderRadius: 'var(--r-sm)',
      cursor: 'pointer',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      background: file === i ? 'var(--surface-accent-soft)' : 'transparent',
      color: file === i ? 'oklch(0.86 0.16 148)' : 'var(--text-body)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "film",
    size: 12
  }), f)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      padding: '20px 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'min(100%,520px)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    inset: true,
    pad: "18px"
  }, /*#__PURE__*/React.createElement(FloorPreview, {
    cols: 10,
    rows: 5,
    animated: playing
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'var(--w-inspector)',
      flex: 'none',
      borderLeft: '1px solid var(--border-hairline)',
      padding: '18px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Layer \xB7 ", clips[selClip].name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)'
    }
  }, "Opacity"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-numeric)'
    }
  }, opacity, "%")), /*#__PURE__*/React.createElement(Slider, {
    value: opacity,
    accent: true,
    onChange: setOpacity,
    width: "100%"
  })), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)'
    }
  }, "Blend"), /*#__PURE__*/React.createElement(Segmented, {
    options: ['Normal', 'Add', 'Mult'],
    value: blend,
    onChange: setBlend
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-hairline)'
    }
  }), /*#__PURE__*/React.createElement(SectionLabel, null, "Transform"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement(KeyValue, {
    label: "Position",
    value: "0, 0"
  }), /*#__PURE__*/React.createElement(KeyValue, {
    label: "Scale",
    value: "100%"
  }), /*#__PURE__*/React.createElement(KeyValue, {
    label: "Rotation",
    value: "0\xB0"
  }), /*#__PURE__*/React.createElement(KeyValue, {
    label: "Fit",
    value: "cover"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-hairline)'
    }
  }), /*#__PURE__*/React.createElement(SectionLabel, null, "FX"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "ghost"
  }, "Add effect\u2026"))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 176,
      flex: 'none',
      borderTop: '1px solid var(--border-hairline)',
      background: 'var(--surface-chrome)',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 28,
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '0 16px',
      borderBottom: '1px solid var(--border-hairline)'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, {
    style: {
      letterSpacing: '0.1em'
    }
  }, "Timeline"), /*#__PURE__*/React.createElement(Timecode, {
    current: "00:21",
    total: "02:00",
    size: "12px"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 96,
      flex: 'none',
      borderRight: '1px solid var(--border-hairline)',
      display: 'flex',
      flexDirection: 'column'
    }
  }, clips.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.layer,
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      fontSize: 'var(--fs-caption)',
      color: 'var(--text-secondary)',
      borderBottom: '1px solid var(--n-4)'
    }
  }, "Layer ", c.layer))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      position: 'relative'
    }
  }, clips.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: c.layer,
    style: {
      position: 'absolute',
      top: i * 25 + '%',
      height: '25%',
      left: 0,
      right: 0,
      borderBottom: '1px solid var(--n-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setSelClip(i),
    style: {
      position: 'absolute',
      left: c.l + '%',
      width: c.w + '%',
      top: 5,
      bottom: 5,
      borderRadius: 'var(--r-xs)',
      background: c.color,
      cursor: 'pointer',
      outline: selClip === i ? '2px solid var(--n-11)' : 'none',
      outlineOffset: 1
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '18%',
      top: 0,
      bottom: 0,
      width: 1,
      background: 'var(--n-9)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: -1,
      left: -4,
      width: 9,
      height: 9,
      background: 'var(--n-9)',
      clipPath: 'polygon(0 0,100% 0,50% 100%)'
    }
  }))))));
}
Object.assign(window, {
  EditScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ddf-mac/edit.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ddf-mac/mapping.jsx
try { (() => {
function MappingScreen() {
  const {
    Panel,
    SectionLabel,
    Button,
    Select,
    ControllerChip,
    Badge
  } = window.PxdfDesignSystem_fee2c8;
  const [type, setType] = React.useState('8x8_4P');
  const [cols, setCols] = React.useState('10');
  const [rows, setRows] = React.useState('5');
  const nc = Math.ceil(+cols / (type.endsWith('8P') ? 8 : 4));
  const per = type.endsWith('8P') ? 8 : 4;
  const [hov, setHov] = React.useState(null);
  const tiles = [];
  for (let y = 0; y < +rows; y++) for (let x = 0; x < +cols; x++) {
    const ctrl = Math.floor(x / per),
      port = x % per,
      k = x + '_' + y;
    tiles.push(/*#__PURE__*/React.createElement("div", {
      key: k,
      onMouseEnter: () => setHov(k),
      onMouseLeave: () => setHov(null),
      style: {
        aspectRatio: '1',
        borderRadius: 'var(--r-cell)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hov === k ? 'var(--surface-accent-soft)' : ctrl % 2 ? 'var(--n-3)' : 'var(--n-2)',
        border: '1px solid ' + (hov === k ? 'var(--border-accent)' : 'var(--floor-tile-line)'),
        transition: 'background var(--dur-fast) var(--ease-out)',
        cursor: 'default'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: hov === k ? 'var(--pxdf-green-hot)' : 'var(--n-6)'
      }
    }, 'C' + (ctrl + 1) + '·' + port)));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: '22px 26px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Mapping \xB7 ", cols, " \xD7 ", rows), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Badge, null, type), /*#__PURE__*/React.createElement(Badge, null, nc + ' controllers'))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      justifyContent: 'center'
    }
  }, Array.from({
    length: nc
  }, (_, i) => {
    const drive = Math.min(per, +cols - i * per);
    return /*#__PURE__*/React.createElement(ControllerChip, {
      key: i,
      label: 'Controller ' + (i + 1),
      ports: per,
      activePorts: drive
    });
  })), /*#__PURE__*/React.createElement(Panel, {
    inset: true,
    pad: "20px",
    style: {
      flex: 1,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(' + cols + ',1fr)',
      gap: 4,
      maxWidth: 640,
      margin: '0 auto',
      width: '100%'
    }
  }, tiles)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "ghost"
  }, "Calibrate\u2026"))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'var(--w-inspector)',
      borderLeft: '1px solid var(--border-hairline)',
      padding: '22px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 20,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Floor"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, [['Type', type, setType, ['8x8_4P', '8x8_8P', '6x6_4P', '6x6_8P']], ['Width', cols, setCols, Array.from({
    length: 14
  }, (_, i) => String(i + 1))], ['Height', rows, setRows, Array.from({
    length: 10
  }, (_, i) => String(i + 1))]].map(f => /*#__PURE__*/React.createElement("label", {
    key: f[0],
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)'
    }
  }, f[0]), /*#__PURE__*/React.createElement(Select, {
    options: f[3],
    value: f[1],
    onChange: f[2],
    width: 172
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-hairline)'
    }
  }), /*#__PURE__*/React.createElement(SectionLabel, null, "Show File"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Button, {
    size: "sm"
  }, "Open\u2026"), /*#__PURE__*/React.createElement(Button, {
    size: "sm"
  }, "Save As\u2026")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    style: {
      width: '100%'
    },
    onClick: () => window.__go && window.__go('Play')
  }, "Open Player"))));
}
Object.assign(window, {
  MappingScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ddf-mac/mapping.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ddf-mac/play.jsx
try { (() => {
function PlayScreen({
  playing,
  setPlaying,
  master,
  setMaster
}) {
  const {
    Panel,
    SectionLabel,
    Button,
    IconButton,
    Segmented,
    Slider,
    Stepper,
    Switch,
    ListRow,
    StatReadout,
    KeyValue,
    FloorPreview,
    TransportBar,
    Timecode
  } = window.PxdfDesignSystem_fee2c8;
  const cues = [['01', 'Doors / Warm', '2:00'], ['02', 'Cocktail Wash', '—'], ['03', 'Grand Entrance', '0:45'], ['04', 'First Dance', '4:36'], ['05', 'Open Floor', '∞'], ['06', 'Last Call', '3:10']];
  const [sel, setSel] = React.useState(3);
  const [mode, setMode] = React.useState('Live');
  const [speed, setSpeed] = React.useState(100);
  const [loops, setLoops] = React.useState(1);
  const [forever, setForever] = React.useState(true);
  const [bright, setBright] = React.useState(100);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'var(--w-sidebar)',
      flex: 'none',
      borderRight: '1px solid var(--border-hairline)',
      padding: '22px 0',
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 20px 8px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Cue Stack"), /*#__PURE__*/React.createElement(IconButton, {
    icon: "plus",
    title: "Add cue",
    style: {
      width: 24,
      height: 24,
      borderRadius: 'var(--r-sm)'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '0 10px',
      overflow: 'auto'
    }
  }, cues.map((c, i) => /*#__PURE__*/React.createElement(ListRow, {
    key: i,
    index: c[0],
    title: c[1],
    meta: c[2],
    selected: i === sel,
    active: i === sel && playing,
    onClick: () => setSel(i)
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: '22px 26px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Floor A \xB7 10 \xD7 5"), /*#__PURE__*/React.createElement(Segmented, {
    options: ['Live', 'Preview'],
    value: mode,
    onChange: setMode
  })), /*#__PURE__*/React.createElement(Panel, {
    inset: true,
    pad: "20px",
    style: {
      flex: 1,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(FloorPreview, {
    cols: 10,
    rows: 5,
    animated: playing,
    hue: mode === 'Live' ? 148 : 265,
    chroma: mode === 'Live' ? 0.22 : 0.16
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'var(--w-inspector)',
      flex: 'none',
      borderLeft: '1px solid var(--border-hairline)',
      padding: '22px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Cue Control"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)'
    }
  }, "Speed"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-numeric)'
    }
  }, speed, "%")), /*#__PURE__*/React.createElement(Slider, {
    value: speed,
    min: 0,
    max: 200,
    accent: true,
    onChange: setSpeed,
    width: "100%"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)'
    }
  }, "Loop"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      color: forever ? 'var(--pxdf-green-hot)' : 'var(--text-muted)'
    }
  }, "\u221E"), /*#__PURE__*/React.createElement(Switch, {
    checked: forever,
    onChange: setForever
  }))), !forever && /*#__PURE__*/React.createElement(Stepper, {
    value: loops,
    min: 1,
    max: 99,
    onChange: setLoops,
    suffix: "\xD7",
    width: 100
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-label)',
      color: 'var(--text-muted)'
    }
  }, "Brightness"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-numeric)'
    }
  }, bright, "%")), /*#__PURE__*/React.createElement(Slider, {
    value: bright,
    accent: true,
    onChange: setBright,
    width: "100%"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-hairline)'
    }
  }), /*#__PURE__*/React.createElement(SectionLabel, null, "Output"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(StatReadout, {
    label: "Frame rate",
    value: playing ? '30.0' : '0.0',
    unit: "fps",
    accent: playing
  }), /*#__PURE__*/React.createElement(StatReadout, {
    label: "Latency",
    value: "4.2",
    unit: "ms"
  }), /*#__PURE__*/React.createElement(StatReadout, {
    label: "Dropped",
    value: "0"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement(KeyValue, {
    label: "Controller",
    value: "PXDF-01"
  }), /*#__PURE__*/React.createElement(KeyValue, {
    label: "Uptime",
    value: "01:12:38"
  })))), /*#__PURE__*/React.createElement(TransportBar, {
    playing: playing,
    onPlay: () => setPlaying(p => !p),
    current: "01:34",
    total: "04:36",
    progress: 0.34,
    master: master,
    onMaster: setMaster
  }));
}
Object.assign(window, {
  PlayScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ddf-mac/play.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Segmented = __ds_scope.Segmented;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Slider = __ds_scope.Slider;

__ds_ns.Stepper = __ds_scope.Stepper;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.TextField = __ds_scope.TextField;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Panel = __ds_scope.Panel;

__ds_ns.SectionLabel = __ds_scope.SectionLabel;

__ds_ns.StatusPill = __ds_scope.StatusPill;

__ds_ns.KeyValue = __ds_scope.KeyValue;

__ds_ns.ListRow = __ds_scope.ListRow;

__ds_ns.StatReadout = __ds_scope.StatReadout;

__ds_ns.Timecode = __ds_scope.Timecode;

__ds_ns.ControllerChip = __ds_scope.ControllerChip;

__ds_ns.FloorPreview = __ds_scope.FloorPreview;

__ds_ns.TransportBar = __ds_scope.TransportBar;

})();
