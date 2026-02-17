export default function ContextUsageBar({ percentage }) {
  if (percentage == null) return null;

  const clamped = Math.min(100, Math.max(0, percentage));
  const rounded = Math.round(clamped);
  const color =
    clamped >= 80 ? 'bg-red-500' :
    clamped >= 50 ? 'bg-yellow-500' :
    'bg-emerald-500';
  const textColor =
    clamped >= 80 ? 'text-red-400' :
    clamped >= 50 ? 'text-yellow-400' :
    'text-emerald-400';

  return (
    <div className="px-4 py-1 border-b border-[#262626] flex items-center gap-2"
         title={`Context window ${rounded}% used`}>
      <span className="text-[10px] text-neutral-500 shrink-0">ctx</span>
      <div className="flex-1 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className={`text-[10px] font-mono tabular-nums ${textColor}`}>
        {rounded}%
      </span>
    </div>
  );
}
