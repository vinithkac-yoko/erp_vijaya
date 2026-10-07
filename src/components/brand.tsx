import { cn } from '@/lib/cn';

/** The copper coil line from the approved prototype: a run of wire loops behind the top bar. */
export function CoilLine({ className }: { className?: string }) {
  const loops = Array.from({ length: 24 }, (_, i) => (i === 0 ? 'M0,45 Q15,10 30,45' : `T${30 * (i + 1)},45`)).join(' ');
  return (
    <svg aria-hidden="true" viewBox="0 0 720 90" preserveAspectRatio="none" className={cn('pointer-events-none absolute inset-0 h-full w-full opacity-15', className)}>
      <path d={loops} fill="none" stroke="var(--copper-light)" strokeWidth="2" />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('whitespace-nowrap leading-none', className)}>
      <div className="font-display text-lg font-bold tracking-wide text-plate-ink">Vijaya Stores</div>
      <div className="mt-1 hidden font-mono text-[10.5px] uppercase tracking-[0.14em] text-copper-light sm:block">Vijaya Electronics</div>
    </div>
  );
}
