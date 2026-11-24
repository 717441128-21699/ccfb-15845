/** 通用 DOM 构造辅助 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; css?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v as string;
    else if (k === 'css') node.setAttribute('style', v as string);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  onChange: (v: number) => void,
): HTMLDivElement {
  const wrap = el('div', { class: 'control' });
  const valText = el('span', { class: 'val' }, [`${value}${unit}`]);
  wrap.append(el('label', {}, [document.createTextNode(label), valText]));
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    valText.textContent = `${v}${unit}`;
    onChange(v);
  });
  wrap.append(input);
  return wrap;
}

export function toast(message: string, durationMs = 2200): void {
  const existing = document.querySelector('.toast');
  existing?.remove();
  const t = el('div', { class: 'toast' }, [message]);
  document.body.append(t);
  setTimeout(() => t.remove(), durationMs);
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatRays(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
}
