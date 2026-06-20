export default function ServiceCardSkeleton() {
  return (
    <div data-testid="service-card-skeleton" className="card p-6 flex flex-col gap-4 animate-pulse">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="h-5 w-40 bg-border/60 rounded" />
        <div className="h-5 w-16 bg-border/60 rounded-full" />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <div className="h-3.5 w-full bg-border/50 rounded" />
        <div className="h-3.5 w-3/4 bg-border/50 rounded" />
      </div>

      {/* Endpoint bar */}
      <div data-testid="skeleton-endpoint" className="flex items-center gap-2 bg-background rounded-lg px-3 py-2 border border-border">
        <div className="h-3.5 w-48 bg-border/50 rounded" />
        <div className="h-3.5 w-10 bg-border/50 rounded ml-auto" />
      </div>

      {/* Price + reputation row */}
      <div className="flex items-center justify-between">
        <div className="h-4 w-24 bg-border/60 rounded" />
        <div className="h-4 w-16 bg-border/50 rounded" />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border pt-3 mt-1">
        <div className="h-3 w-28 bg-border/50 rounded" />
        <div className="h-3 w-20 bg-border/50 rounded" />
      </div>

      {/* Button */}
      <div data-testid="skeleton-button" className="h-10 w-full bg-border/40 rounded-full" />
    </div>
  );
}
