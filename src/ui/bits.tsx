/** Progress meter with an optional uncertainty range. */
export function Meter({ value, lo, hi }: { value: number; lo?: number; hi?: number }) {
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      {lo !== undefined && hi !== undefined && <i className="range" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />}
      <i style={{ width: `${value * 100}%` }} />
    </div>
  );
}

export function downloadText(name: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
