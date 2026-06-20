export default function AgentCardSkeleton() {
  return (
    <div data-testid="agent-card-skeleton" className="card p-6 flex flex-col gap-4 animate-pulse">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-5 w-36 bg-border/60 rounded" />
          <div className="h-3 w-28 bg-border/50 rounded" />
        </div>
        <div data-testid="skeleton-badge" className="h-6 w-14 bg-border/60 rounded-full" />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <div className="h-3.5 w-full bg-border/50 rounded" />
        <div className="h-3.5 w-2/3 bg-border/50 rounded" />
      </div>

      {/* Stats row */}
      <div data-testid="skeleton-stats" className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-background rounded-lg px-3 py-2 border border-border text-center space-y-1.5">
            <div className="h-4 w-10 bg-border/60 rounded mx-auto" />
            <div className="h-3 w-14 bg-border/40 rounded mx-auto" />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border pt-3 mt-1 flex items-center justify-between">
        <div className="h-3 w-24 bg-border/50 rounded" />
        <div className="h-3 w-20 bg-border/50 rounded" />
      </div>
    </div>
  );
}
