import type { SpendingPolicy } from '@/lib/types';

const STROOPS_PER_USDC = 10_000_000n;

function stroopsToUsdc(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / STROOPS_PER_USDC;
  const frac = String(n % STROOPS_PER_USDC).padStart(7, '0').slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}

interface Props {
  policy: SpendingPolicy;
}

export default function SpendingPolicyDisplay({ policy }: Props) {
  const hasMaxDay = policy.max_per_day_stroops !== '0';
  const dailyUsed = hasMaxDay
    ? Number(BigInt(policy.daily_spent_stroops) * 100n / BigInt(policy.max_per_day_stroops))
    : 0;

  return (
    <div className="card p-6 flex flex-col gap-5">
      <h3 className="font-semibold text-base">Spending Policy</h3>

      <div className="grid sm:grid-cols-2 gap-4">
        <PolicyRow
          label="Max per transaction"
          value={`$${stroopsToUsdc(policy.max_per_tx_stroops)} USDC`}
        />
        <PolicyRow
          label="Max per day"
          value={hasMaxDay ? `$${stroopsToUsdc(policy.max_per_day_stroops)} USDC` : 'No daily limit'}
        />
        <PolicyRow
          label="Min score to earn"
          value={policy.min_score_to_earn === 0 ? 'None' : String(policy.min_score_to_earn)}
        />
        <PolicyRow
          label="Allowed categories"
          value={
            policy.allowed_categories.length > 0
              ? policy.allowed_categories.join(', ')
              : 'All categories'
          }
        />
      </div>

      {/* Daily spend progress */}
      {hasMaxDay ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-secondary">Daily spend used</span>
            <span className="mono text-xs text-primary">
              ${stroopsToUsdc(policy.daily_spent_stroops)} / ${stroopsToUsdc(policy.max_per_day_stroops)} USDC
            </span>
          </div>
          <div className="w-full bg-border rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full transition-all ${
                dailyUsed > 90 ? 'bg-error' : dailyUsed > 70 ? 'bg-accent' : 'bg-success'
              }`}
              style={{ width: `${Math.min(dailyUsed, 100)}%` }}
            />
          </div>
          <p className="text-xs text-secondary mt-1.5">
            Resets every ~17,280 ledgers (≈24 hours)
          </p>
        </div>
      ) : (
        <p className="text-xs text-secondary">
          ${stroopsToUsdc(policy.daily_spent_stroops)} USDC spent today · no daily cap
        </p>
      )}
    </div>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background rounded-lg px-4 py-3 border border-border">
      <div className="text-xs text-secondary mb-1">{label}</div>
      <div className="text-sm font-medium mono">{value}</div>
    </div>
  );
}
